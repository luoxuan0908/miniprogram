const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const modelCatalog = require('./billing-models.json')
const priceTable = require('./billing-prices.json')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const ACCOUNTS = 'billing_accounts'
const LEDGER = 'billing_ledger'
const CURRENCY = 'CNY'
const MICROS_PER_YUAN = 1000000
const DEFAULT_INITIAL_BALANCE_MICROS = readInteger(process.env.BILLING_INITIAL_BALANCE_MICROS, 10 * MICROS_PER_YUAN)
const ENFORCE_BALANCE = process.env.BILLING_ENFORCE_BALANCE !== 'false'

const SUPPORTED_METERS = [
  'input_tokens',
  'output_tokens',
  'cached_input_tokens',
  'tts_chars',
  'audio_input_seconds',
  'audio_output_seconds',
  'audio_input_tokens',
  'audio_output_tokens',
  'request_count'
]

function readInteger(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

function now() {
  return Date.now()
}

function hash(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 24)
}

function accountId(openid) {
  return `acct_${hash(openid)}`
}

function ledgerId(openid, requestId) {
  return `ledger_${hash(`${openid}:${requestId}`)}`
}

function findModel(modelKey) {
  const models = Array.isArray(modelCatalog.models) ? modelCatalog.models : []
  return models.find(item => item.modelKey === modelKey) || null
}

function assertModel(modelKey) {
  const model = findModel(modelKey)
  if (!model) {
    throw new Error(`模型未登记: ${modelKey}`)
  }
  if (model.enabled === false) {
    throw new Error(`模型已停用: ${modelKey}`)
  }
  return model
}

function toPositiveNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function normalizeMeters(meters) {
  const result = {}
  const source = meters && typeof meters === 'object' ? meters : {}
  SUPPORTED_METERS.forEach(meter => {
    const value = toPositiveNumber(source[meter])
    if (value > 0) result[meter] = value
  })
  return result
}

function usageNumber(usage, names) {
  for (const name of names) {
    const value = toPositiveNumber(usage && usage[name])
    if (value > 0) return value
  }
  return 0
}

function adaptProviderUsage(usage, fallbackMeters) {
  if (!usage || typeof usage !== 'object') {
    return { meters: normalizeMeters(fallbackMeters), usageSource: 'estimated' }
  }

  const promptTokens = usageNumber(usage, ['prompt_tokens', 'input_tokens', 'total_input_tokens'])
  const completionTokens = usageNumber(usage, ['completion_tokens', 'output_tokens', 'total_output_tokens'])
  const cachedInputTokens = usageNumber(usage, ['cached_input_tokens', 'prompt_cache_hit_tokens', 'cache_hit_tokens'])
  const audioInputTokens = usageNumber(usage, ['audio_input_tokens', 'input_audio_tokens'])
  const audioOutputTokens = usageNumber(usage, ['audio_output_tokens', 'output_audio_tokens'])

  const meters = {}
  if (promptTokens > 0) meters.input_tokens = Math.max(0, promptTokens - cachedInputTokens)
  if (completionTokens > 0) meters.output_tokens = completionTokens
  if (cachedInputTokens > 0) meters.cached_input_tokens = cachedInputTokens
  if (audioInputTokens > 0) meters.audio_input_tokens = audioInputTokens
  if (audioOutputTokens > 0) meters.audio_output_tokens = audioOutputTokens

  return Object.keys(meters).length
    ? { meters, usageSource: 'provider' }
    : { meters: normalizeMeters(fallbackMeters), usageSource: 'estimated' }
}

function findPrice(model, operation, meter) {
  const prices = Array.isArray(priceTable.prices) ? priceTable.prices : []
  const targetOperation = operation || model.operation
  return prices.find(item => (
    item.provider === model.provider &&
    item.model === model.providerModel &&
    item.operation === targetOperation &&
    item.meter === meter &&
    item.currency === CURRENCY &&
    (!model.priceVersion || item.version === model.priceVersion)
  )) || null
}

function calculateAmount(model, operation, meters) {
  const normalized = normalizeMeters(meters)
  const meterNames = Object.keys(normalized)
  if (!meterNames.length) {
    return {
      amountMicros: 0,
      pricingStatus: 'unpriced',
      pendingPricing: true,
      priceSnapshot: []
    }
  }

  const priceSnapshot = []
  let missingPrice = false
  let amountMicros = 0

  meterNames.forEach(meter => {
    const quantity = normalized[meter]
    const price = findPrice(model, operation, meter)
    if (!price) {
      missingPrice = true
      priceSnapshot.push({
        meter,
        quantity,
        pricingStatus: 'missing_price',
        provider: model.provider,
        model: model.providerModel,
        operation: operation || model.operation,
        currency: CURRENCY
      })
      return
    }

    const unitSize = Math.max(1, Number(price.unitSize) || 1)
    const costMicros = Math.max(0, Number(price.costMicros) || 0)
    const markupMultiplier = Number.isFinite(Number(price.markupMultiplier)) ? Number(price.markupMultiplier) : 1
    const lineAmountMicros = Math.ceil((quantity / unitSize) * costMicros * markupMultiplier)
    amountMicros += lineAmountMicros
    priceSnapshot.push({
      meter,
      quantity,
      provider: price.provider,
      model: price.model,
      operation: price.operation,
      version: price.version,
      effectiveFrom: price.effectiveFrom,
      currency: price.currency,
      unitSize,
      costMicros,
      markupMultiplier,
      sourceNote: price.sourceNote || '',
      amountMicros: lineAmountMicros
    })
  })

  if (missingPrice) {
    return {
      amountMicros: 0,
      pricingStatus: 'unpriced',
      pendingPricing: true,
      priceSnapshot
    }
  }

  return {
    amountMicros,
    pricingStatus: 'priced',
    pendingPricing: false,
    priceSnapshot
  }
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name)
  } catch (err) {
    const message = err && (err.errMsg || err.message || '')
    if (!String(message).includes('already exists') && !String(message).includes('collection exist')) {
      console.warn(`ensureCollection(${name}) failed:`, message)
    }
  }
}

async function ensureAccount(openid) {
  await ensureCollection(ACCOUNTS)
  const accountKey = accountId(openid)
  try {
    const res = await db.collection(ACCOUNTS)
      .where({ _openid: openid, accountKey })
      .limit(1)
      .get()
    if (res.data && res.data[0]) return res.data[0]
  } catch (err) {
    // Missing document is expected for first-time users.
  }

  const timestamp = now()
  const account = {
    _id: accountKey,
    accountKey,
    _openid: openid,
    ownerId: openid,
    balanceMicros: DEFAULT_INITIAL_BALANCE_MICROS,
    grantedMicros: DEFAULT_INITIAL_BALANCE_MICROS,
    chargedMicros: 0,
    currency: CURRENCY,
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp
  }

  try {
    await db.collection(ACCOUNTS).add({ data: account })
    return account
  } catch (err) {
    const existing = await db.collection(ACCOUNTS)
      .where({ _openid: openid, accountKey })
      .limit(1)
      .get()
    if (existing.data && existing.data[0]) return existing.data[0]
    const { _id, ...accountWithoutCustomId } = account
    await db.collection(ACCOUNTS).add({ data: accountWithoutCustomId })
    return accountWithoutCustomId
  }
}

async function getAccount(openid) {
  const account = await ensureAccount(openid)
  await ensureCollection(LEDGER)
  const recentRes = await getLedgerPage(openid, 5, 0)
  const recentLedger = (recentRes.data || []).map(formatLedger)
  const totalCalls = await countLedgerForUser(openid, {}, recentLedger.length)
  const unpricedCalls = await countLedgerForUser(openid, { pendingPricing: true },
    recentLedger.filter(item => item.pendingPricing || item.pricingStatus === 'unpriced').length)
  return {
    success: true,
    account: formatAccount(account),
    usageSummary: {
      totalCalls,
      recentCalls: recentLedger.length,
      unpricedCalls
    },
    recentLedger
  }
}

async function getLedgerPage(openid, limit, offset) {
  const [primary, owner] = await Promise.all([
    db.collection(LEDGER)
      .where({ _openid: openid })
      .orderBy('createdAt', 'desc')
      .skip(offset)
      .limit(limit)
      .get(),
    db.collection(LEDGER)
      .where({ ownerId: openid })
      .orderBy('createdAt', 'desc')
      .skip(offset)
      .limit(limit)
      .get()
  ])

  const byId = new Map()
  ;[...(primary.data || []), ...(owner.data || [])].forEach(record => {
    const key = record._id || record.ledgerKey || record.requestId
    if (key) byId.set(key, record)
  })

  return {
    data: Array.from(byId.values())
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, limit)
  }
}

async function countLedgerWhere(where, fallback = 0) {
  try {
    const res = await db.collection(LEDGER).where(where).count()
    return Number(res.total || 0)
  } catch (err) {
    console.warn('count ledger failed:', err && (err.errMsg || err.message))
    return fallback
  }
}

async function countLedgerForUser(openid, extraWhere = {}, fallback = 0) {
  const primary = await countLedgerWhere({ _openid: openid, ...extraWhere }, 0)
  const owner = await countLedgerWhere({ ownerId: openid, ...extraWhere }, 0)
  return Math.max(primary, owner, fallback)
}

function formatMoneyMicros(value) {
  return (Number(value || 0) / MICROS_PER_YUAN).toFixed(4)
}

function formatAccount(account) {
  return {
    _id: account._id,
    accountKey: account.accountKey || '',
    balanceMicros: Number(account.balanceMicros || 0),
    balanceYuan: formatMoneyMicros(account.balanceMicros),
    grantedMicros: Number(account.grantedMicros || 0),
    chargedMicros: Number(account.chargedMicros || 0),
    chargedYuan: formatMoneyMicros(account.chargedMicros),
    currency: account.currency || CURRENCY,
    status: account.status || 'active',
    updatedAt: account.updatedAt || 0
  }
}

function formatLedger(record) {
  return {
    _id: record._id,
    requestId: record.requestId,
    operation: record.operation,
    feature: record.metadata && record.metadata.feature,
    modelKey: record.modelKey,
    provider: record.provider,
    providerModel: record.providerModel,
    meters: record.meters || {},
    amountMicros: Number(record.amountMicros || 0),
    amountYuan: formatMoneyMicros(record.amountMicros),
    pricingStatus: record.pricingStatus,
    pendingPricing: !!record.pendingPricing,
    usageSource: record.usageSource,
    createdAt: record.createdAt || 0,
    priceSnapshot: record.priceSnapshot || []
  }
}

function formatModel(model) {
  return {
    modelKey: model.modelKey,
    provider: model.provider,
    providerModel: model.providerModel,
    operation: model.operation,
    usageAdapter: model.usageAdapter,
    priceVersion: model.priceVersion
  }
}

async function getLedger(openid, event) {
  await ensureAccount(openid)
  await ensureCollection(LEDGER)
  const limit = Math.min(50, Math.max(1, Number(event.limit) || 20))
  const offset = Math.max(0, Number(event.offset) || 0)
  const res = await getLedgerPage(openid, limit, offset)
  const total = await countLedgerForUser(openid, {}, offset + ((res.data || []).length))

  return {
    success: true,
    ledger: (res.data || []).map(formatLedger),
    total,
    offset,
    limit
  }
}

function buildUsage(event, model) {
  const adapted = adaptProviderUsage(event.providerUsage, event.meters)
  const meters = normalizeMeters(adapted.meters)
  return {
    meters,
    usageSource: adapted.usageSource === 'provider' ? 'provider' : (event.usageSource || adapted.usageSource || 'estimated'),
    providerUsage: event.providerUsage || null,
    adapter: model.usageAdapter || ''
  }
}

function getRequestId(event) {
  const requestId = String(event.requestId || '').trim()
  if (!requestId) {
    throw new Error('requestId 不能为空')
  }
  return requestId.slice(0, 120)
}

async function precheck(openid, event) {
  const requestId = getRequestId(event)
  const model = assertModel(event.modelKey)
  const account = await ensureAccount(openid)
  const operation = event.operation || model.operation
  const usage = buildUsage(event, model)
  const pricing = calculateAmount(model, operation, usage.meters)
  const allowed = !ENFORCE_BALANCE ||
    pricing.pricingStatus !== 'priced' ||
    pricing.amountMicros <= Number(account.balanceMicros || 0)

  return {
    success: true,
    requestId,
    allowed,
    error: allowed ? '' : 'AI 余额不足',
    account: formatAccount(account),
    model: formatModel(model),
    estimate: pricing,
    meters: usage.meters,
    usageSource: usage.usageSource
  }
}

async function settle(openid, event) {
  await ensureCollection(LEDGER)
  const requestId = getRequestId(event)
  const ledgerKey = ledgerId(openid, requestId)

  try {
    const existing = await db.collection(LEDGER)
      .where({ _openid: openid, requestId })
      .limit(1)
      .get()
    if (existing.data && existing.data[0]) {
      return {
        success: true,
        idempotent: true,
        ledger: formatLedger(existing.data[0])
      }
    }
  } catch (err) {
    // Missing ledger is expected for the first successful settlement.
  }

  const model = assertModel(event.modelKey)
  const account = await ensureAccount(openid)
  const operation = event.operation || model.operation
  const usage = buildUsage(event, model)
  const pricing = calculateAmount(model, operation, usage.meters)
  const timestamp = now()
  const amountMicros = pricing.pricingStatus === 'priced' ? pricing.amountMicros : 0
  const balanceBeforeMicros = Number(account.balanceMicros || 0)
  const balanceAfterMicros = balanceBeforeMicros - amountMicros

  const record = {
    _id: ledgerKey,
    ledgerKey,
    _openid: openid,
    ownerId: openid,
    requestId,
    operation,
    modelKey: model.modelKey,
    provider: model.provider,
    providerModel: model.providerModel,
    providerUsage: usage.providerUsage,
    usageAdapter: usage.adapter,
    usageSource: usage.usageSource,
    meters: usage.meters,
    priceSnapshot: pricing.priceSnapshot,
    amountMicros,
    currency: CURRENCY,
    pricingStatus: pricing.pricingStatus,
    pendingPricing: pricing.pendingPricing,
    balanceBeforeMicros,
    balanceAfterMicros,
    metadata: event.metadata && typeof event.metadata === 'object' ? event.metadata : {},
    createdAt: timestamp,
    updatedAt: timestamp
  }

  try {
    await db.collection(LEDGER).add({ data: record })
  } catch (err) {
    const existing = await db.collection(LEDGER)
      .where({ _openid: openid, requestId })
      .limit(1)
      .get()
    if (existing.data && existing.data[0]) {
      return {
        success: true,
        idempotent: true,
        ledger: formatLedger(existing.data[0])
      }
    }
    const { _id, ...recordWithoutCustomId } = record
    await db.collection(LEDGER).add({ data: recordWithoutCustomId })
  }

  if (amountMicros > 0) {
    await db.collection(ACCOUNTS).where({ _openid: openid, accountKey: account.accountKey }).update({
      data: {
        balanceMicros: _.inc(-amountMicros),
        chargedMicros: _.inc(amountMicros),
        updatedAt: timestamp
      }
    })
  } else {
    await db.collection(ACCOUNTS).where({ _openid: openid, accountKey: account.accountKey }).update({
      data: { updatedAt: timestamp }
    })
  }

  return {
    success: true,
    idempotent: false,
    ledger: formatLedger(record)
  }
}

async function estimate(event) {
  const model = assertModel(event.modelKey)
  const operation = event.operation || model.operation
  const usage = buildUsage(event, model)
  const pricing = calculateAmount(model, operation, usage.meters)
  return {
    success: true,
    model: formatModel(model),
    meters: usage.meters,
    usageSource: usage.usageSource,
    estimate: pricing
  }
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID || event.openid
  if (!openid) return { success: false, error: '无法识别用户' }

  try {
    const action = event.action || 'getAccount'
    if (action === 'getAccount') return getAccount(openid)
    if (action === 'getLedger') return getLedger(openid, event)
    if (action === 'precheck') return precheck(openid, event)
    if (action === 'settle') return settle(openid, event)
    if (action === 'estimate') return estimate(event)
    return { success: false, error: `未知计费动作: ${action}` }
  } catch (err) {
    console.error('billing error:', err)
    return { success: false, error: err.message || '计费服务异常' }
  }
}
