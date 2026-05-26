#!/usr/bin/env node

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const constants = require('../miniprogram/utils/constants')

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'))
}

function fileExists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath))
}

function checkConfigConsistency() {
  const projectConfig = readJson('project.config.json')
  const appJs = fs.readFileSync(path.join(ROOT, 'miniprogram/app.js'), 'utf8')

  assert.strictEqual(projectConfig.appid, constants.APP_ID, 'project.config.json appid must match constants.APP_ID')
  assert(appJs.includes('CLOUD_ENV_ID'), 'app.js must initialize wx.cloud with CLOUD_ENV_ID')
}

function checkAppPages() {
  const appJson = readJson('miniprogram/app.json')
  const adminPage = ['pages', 'admin', 'admin'].join('/')
  assert(!appJson.pages.includes(adminPage), 'admin debug page must not be packaged in app.json')

  for (const page of appJson.pages) {
    for (const ext of ['js', 'json', 'wxml', 'wxss']) {
      assert(fileExists(`miniprogram/${page}.${ext}`), `missing page file: miniprogram/${page}.${ext}`)
    }
  }
}

function loadCourseFixture() {
  const coursesPath = path.join(ROOT, 'scripts/output/courses.json')
  const itemsPath = path.join(ROOT, 'scripts/output/course_items.json')

  if (fs.existsSync(coursesPath) && fs.existsSync(itemsPath)) {
    return {
      courses: JSON.parse(fs.readFileSync(coursesPath, 'utf8')),
      items: JSON.parse(fs.readFileSync(itemsPath, 'utf8'))
    }
  }

  return {
    courses: [{
      id: 'idioms-1355',
      type: 'idioms',
      title: '美语习语 1355',
      totalItems: 2,
      isActive: true
    }],
    items: [
      {
        id: 'idiom-0001',
        courseId: 'idioms-1355',
        index: 1,
        title: '9-to-5',
        definition: { cn: '朝九晚五', en: 'regular working hours' },
        examples: [{ en: 'She works a typical 9-to-5 job.', cn: '她做朝九晚五的工作。' }]
      },
      {
        id: 'idiom-0002',
        courseId: 'idioms-1355',
        index: 2,
        title: 'A blessing in disguise',
        definition: { cn: '因祸得福', en: 'a hidden benefit' },
        examples: [{ en: 'The delay was a blessing in disguise.', cn: '这次延误反而是好事。' }]
      }
    ]
  }
}

function checkCourseDataShape(courses, items) {
  assert(Array.isArray(courses) && courses.length > 0, 'courses data must not be empty')
  assert(Array.isArray(items) && items.length > 0, 'course_items data must not be empty')

  const courseIds = new Set(courses.map(course => course.id))
  const itemIds = new Set()

  for (const course of courses) {
    assert(course.id, 'course.id is required')
    assert(course.type, `course.type is required for ${course.id}`)
    assert(course.title, `course.title is required for ${course.id}`)
    assert(Number(course.totalItems) > 0, `course.totalItems must be positive for ${course.id}`)
  }

  for (const item of items) {
    assert(item.id, 'course item id is required')
    assert(!itemIds.has(item.id), `duplicate course item id: ${item.id}`)
    itemIds.add(item.id)
    assert(courseIds.has(item.courseId), `item ${item.id} references unknown course ${item.courseId}`)
    assert(Number(item.index) > 0, `item ${item.id} index must be positive`)
    assert(item.title, `item ${item.id} title is required`)
    assert(item.definition && (item.definition.cn || item.definition.en), `item ${item.id} needs a definition`)
  }
}

function createWxMock(seed, options = {}) {
  const storage = new Map()
  if (options.openid !== null) {
    storage.set('openid', options.openid || 'test-openid')
  }
  const failCollections = new Set(options.failCollections || [])

  const collections = {
    courses: seed.courses.map((item, index) => ({ _id: `course-${index}`, ...item })),
    course_sections: [],
    course_items: seed.items.map((item, index) => ({ _id: `item-${index}`, ...item })),
    userCourseProgress: []
  }

  function getByPath(source, dottedPath) {
    return String(dottedPath).split('.').reduce((value, key) => {
      if (value === undefined || value === null) return undefined
      return value[key]
    }, source)
  }

  function matchesWhere(record, where) {
    return Object.entries(where || {}).every(([key, expected]) => {
      const actual = getByPath(record, key)
      if (expected instanceof RegExp) return expected.test(String(actual || ''))
      return actual === expected
    })
  }

  function collection(name) {
    const records = collections[name] || (collections[name] = [])
    const query = {
      whereClause: {},
      order: null,
      skipCount: 0,
      limitCount: records.length,
      where(whereClause) {
        this.whereClause = whereClause || {}
        return this
      },
      orderBy(field, direction) {
        this.order = { field, direction }
        return this
      },
      skip(count) {
        this.skipCount = count || 0
        return this
      },
      limit(count) {
        this.limitCount = count || records.length
        return this
      },
      async get() {
        if (failCollections.has(name)) {
          throw new Error(`mock read blocked: ${name}`)
        }
        let data = records.filter(record => matchesWhere(record, this.whereClause))
        if (this.order) {
          const factor = this.order.direction === 'desc' ? -1 : 1
          data = data.slice().sort((a, b) => (getByPath(a, this.order.field) - getByPath(b, this.order.field)) * factor)
        }
        data = data.slice(this.skipCount, this.skipCount + this.limitCount)
        return { data }
      },
      async count() {
        return { total: records.filter(record => matchesWhere(record, this.whereClause)).length }
      },
      async add({ data }) {
        const _id = `${name}-${records.length + 1}`
        records.push({ _id, _openid: 'test-openid', ...data })
        return { _id }
      },
      doc(id) {
        return {
          async update({ data }) {
            const index = records.findIndex(record => record._id === id)
            assert(index >= 0, `cannot update missing doc ${id}`)
            records[index] = { ...records[index], ...data }
            return { updated: 1 }
          }
        }
      }
    }
    return query
  }

  global.wx = {
    getStorageSync(key) {
      return storage.has(key) ? storage.get(key) : ''
    },
    setStorageSync(key, value) {
      storage.set(key, value)
    },
    removeStorageSync(key) {
      storage.delete(key)
    },
    getStorageInfoSync() {
      return { keys: Array.from(storage.keys()) }
    },
    cloud: {
      database() {
        return {
          collection,
          RegExp({ regexp, options }) {
            return new RegExp(regexp, options)
          }
        }
      },
      callFunction({ name, data, success, fail }) {
        if (options.disableCallFunction || name !== 'importCourseData') {
          if (typeof fail === 'function') fail(new Error(`mock function unavailable: ${name}`))
          return
        }

        const event = data || {}
        const page = Math.max(1, Number(event.page) || 1)
        const pageSize = Math.max(1, Math.min(Number(event.pageSize) || 50, 100))
        let result
        if (event.action === 'listCourses') {
          result = { success: true, courses: collections.courses.filter(course => course.isActive !== false) }
        } else if (event.action === 'listSections') {
          result = { success: true, sections: collections.course_sections.filter(section => section.courseId === event.courseId) }
        } else if (event.action === 'listItems') {
          let items = collections.course_items.filter(item => item.courseId === event.courseId)
          if (event.sectionIndex !== undefined && event.sectionIndex !== null && event.sectionIndex !== '') {
            items = items.filter(item => getByPath(item, 'extra.sectionIndex') === Number(event.sectionIndex))
          }
          items = items
            .slice()
            .sort((a, b) => Number(a.index) - Number(b.index))
            .slice((page - 1) * pageSize, page * pageSize)
          result = { success: true, items, page, pageSize }
        } else if (event.action === 'getItem') {
          result = {
            success: true,
            item: collections.course_items.find(item => item.courseId === event.courseId && item.id === event.itemId) || null
          }
        } else if (event.action === 'searchItems') {
          const keyword = String(event.keyword || '').toLowerCase()
          result = {
            success: true,
            items: collections.course_items.filter(item =>
              item.courseId === event.courseId && String(item.title || '').toLowerCase().includes(keyword)
            ).slice(0, 50)
          }
        } else {
          result = { success: false, error: `unknown action: ${event.action}` }
        }
        if (typeof success === 'function') success({ result })
      }
    }
  }

  return { collections, storage }
}

async function checkCourseRuntimeFlow(seed) {
  const limitedSeed = {
    courses: seed.courses,
    items: seed.items.slice(0, 60)
  }
  const wxMock = createWxMock(limitedSeed)
  const storageModulePath = require.resolve('../miniprogram/utils/course-storage')
  delete require.cache[storageModulePath]
  const courseStorage = require('../miniprogram/utils/course-storage')

  courseStorage.initForActiveUser()
  assert.strictEqual(courseStorage.getAllCourses().length, 0, 'course catalog starts empty when local cache is cold')

  const courses = await courseStorage.getAllCoursesAsync()
  assert.strictEqual(courses.length, limitedSeed.courses.filter(course => course.isActive !== false).length, 'course catalog should hydrate from cloud')

  const courseId = courses[0].id
  const firstPage = await courseStorage.getCourseItems(courseId, 1)
  assert.strictEqual(firstPage.length, Math.min(50, limitedSeed.items.length), 'course first page should load')

  const secondPage = await courseStorage.getCourseItems(courseId, 2)
  assert.strictEqual(secondPage.length, Math.max(0, limitedSeed.items.length - 50), 'course second page should load remaining records')

  const firstItem = await courseStorage.getCourseItem(courseId, firstPage[0].id)
  assert.strictEqual(firstItem.title, firstPage[0].title, 'course item detail should resolve')

  const results = await courseStorage.searchCourseItems(courseId, firstPage[0].title.slice(0, 3))
  assert(results.length > 0, 'course search should find loaded records')

  courseStorage.markAsLearning(courseId, firstPage[0].id)
  await new Promise(resolve => setTimeout(resolve, 0))
  courseStorage.markAsMastered(courseId, firstPage[0].id)
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.strictEqual(wxMock.collections.userCourseProgress.length, 1, 'progress sync should upsert instead of duplicating records')
  assert.strictEqual(wxMock.collections.userCourseProgress[0].status, 'mastered', 'progress sync should update the existing record')

  const progressIndex = wxMock.storage.get('u:test-openid:course_progress_index')
  assert(Array.isArray(progressIndex) && progressIndex.length === 1, 'progress index should persist locally')
}

async function checkCoursePublicRuntimeBeforeLogin(seed) {
  const limitedSeed = {
    courses: seed.courses,
    items: seed.items.slice(0, 10)
  }
  createWxMock(limitedSeed, { openid: null })
  const storageModulePath = require.resolve('../miniprogram/utils/course-storage')
  delete require.cache[storageModulePath]
  const courseStorage = require('../miniprogram/utils/course-storage')

  courseStorage.initForActiveUser()
  const courses = await courseStorage.getAllCoursesAsync()
  assert.strictEqual(courses.length, limitedSeed.courses.filter(course => course.isActive !== false).length, 'public course catalog should hydrate before login finishes')

  const firstPage = await courseStorage.getCourseItems(courses[0].id, 1)
  assert.strictEqual(firstPage.length, limitedSeed.items.length, 'public course items should load before login finishes')
}

function resetCourseModules() {
  [
    '../miniprogram/utils/course-storage',
    '../miniprogram/data/built-in-courses',
    '../miniprogram/pages/courses/courses'
  ].forEach(modulePath => {
    delete require.cache[require.resolve(modulePath)]
  })
}

function createPageInstance(definition) {
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data || {})),
    setData(patch) {
      this.data = {
        ...this.data,
        ...(patch || {})
      }
    }
  }
}

async function checkCoursesPageFallback(seed) {
  createWxMock(seed, {
    openid: null,
    failCollections: ['courses'],
    disableCallFunction: true
  })
  resetCourseModules()

  let pageDefinition = null
  global.Page = definition => { pageDefinition = definition }
  require('../miniprogram/pages/courses/courses')
  delete global.Page

  const page = createPageInstance(pageDefinition)
  await page.loadCourses()

  assert.strictEqual(page.data.loading, false, 'courses page should stop loading')
  assert.strictEqual(page.data.courses.length, 1, 'courses page should show built-in catalog when cloud reads fail')
  assert.strictEqual(page.data.courses[0].id, 'idioms-1355', 'courses page fallback should show the imported idiom course')
}

async function checkCourseFunctionFallback(seed) {
  createWxMock(seed, {
    failCollections: ['courses', 'course_items']
  })
  resetCourseModules()
  const courseStorage = require('../miniprogram/utils/course-storage')

  courseStorage.initForActiveUser()
  const courses = await courseStorage.getAllCoursesAsync()
  assert.strictEqual(courses.length, seed.courses.filter(course => course.isActive !== false).length, 'course catalog should fall back to cloud function')

  const items = await courseStorage.getCourseItems(courses[0].id, 1)
  assert.strictEqual(items.length, Math.min(50, seed.items.length), 'course items should fall back to cloud function')
}

async function main() {
  checkConfigConsistency()
  checkAppPages()

  const seed = loadCourseFixture()
  checkCourseDataShape(seed.courses, seed.items)
  await checkCourseRuntimeFlow(seed)
  await checkCoursePublicRuntimeBeforeLogin(seed)
  await checkCoursesPageFallback(seed)
  await checkCourseFunctionFallback(seed)

  console.log('Core flow checks passed')
}

main().catch(err => {
  console.error(err.stack || err.message || err)
  process.exit(1)
})
