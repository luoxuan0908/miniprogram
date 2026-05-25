/**
 * upload-idiom-audio.js - 生成小程序端批量上传习语音频的脚本
 *
 * 用法: node scripts/upload-idiom-audio.js [--start 1] [--end 1355] [--batch 5]
 *
 * 生成一个可在小程序开发者工具控制台粘贴执行的 JS 脚本，
 * 分批调用 uploadIdiomAudio 云函数，上传音频并更新数据库。
 */

const fs = require('fs')
const path = require('path')

const OUTPUT_DIR = path.resolve(__dirname, 'output')

const args = process.argv.slice(2)
function getArg(name, defaultVal) {
  const idx = args.indexOf('--' + name)
  return idx >= 0 && idx + 1 < args.length ? parseInt(args[idx + 1], 10) : defaultVal
}

const START = getArg('start', 1)
const END = getArg('end', 1355)
const BATCH = getArg('batch', 5)

function generate() {
  console.log(`生成上传脚本: 习语 ${START}~${END}, 每批 ${BATCH}`)

  const batches = []
  for (let i = START; i <= END; i += BATCH) {
    const count = Math.min(BATCH, END - i + 1)
    batches.push({ startIndex: i, count, updateDb: true })
  }

  console.log(`共 ${batches.length} 批`)

  const script = `// 习语音频批量上传脚本
// 粘贴到小程序开发者工具 Console 执行
// 总计 ${batches.length} 批，${END - START + 1} 条习语
// 音频上传 + 数据库更新一步到位

const batches = ${JSON.stringify(batches)};

let completed = 0;
let totalSuccess = 0;
let totalFail = 0;
let totalDbUpdated = 0;
let failedBatches = [];

async function runUpload() {
  console.log('开始上传，共', batches.length, '批');
  wx.showLoading({ title: '0/' + batches.length, mask: true });

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      const res = await new Promise((resolve, reject) => {
        wx.cloud.callFunction({
          name: 'uploadIdiomAudio',
          data: batch,
          success: r => resolve(r.result),
          fail: e => reject(e)
        });
      });

      if (res && res.success) {
        completed++;
        totalSuccess += res.successCount || 0;
        totalFail += res.failCount || 0;
        totalDbUpdated += res.dbUpdated || 0;

        wx.hideLoading();
        wx.showLoading({ title: completed + '/' + batches.length, mask: true });
        console.log('批次', i + 1, '/', batches.length,
          '| 成功:', res.successCount,
          '| 失败:', res.failCount,
          '| DB更新:', res.dbUpdated);
      } else {
        failedBatches.push(batch);
        console.error('批次', i + 1, '失败:', res);
      }
    } catch (err) {
      failedBatches.push(batch);
      console.error('批次', i + 1, '异常:', err);
    }

    // 每批之间等 500ms
    if (i < batches.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  wx.hideLoading();
  console.log('===== 上传完成 =====');
  console.log('音频成功:', totalSuccess);
  console.log('音频失败:', totalFail);
  console.log('数据库更新:', totalDbUpdated, '条');
  console.log('失败批次:', failedBatches.length);

  if (failedBatches.length > 0) {
    console.log('可重试失败批次，粘贴以下代码:');
    console.log('const retryBatches = ' + JSON.stringify(failedBatches) + ';');
  }
}

runUpload();
`

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  }

  const scriptPath = path.join(OUTPUT_DIR, 'upload-idiom-audio.mini.js')
  fs.writeFileSync(scriptPath, script, 'utf-8')
  console.log(`脚本已生成: ${scriptPath}`)
  console.log('')
  console.log('步骤:')
  console.log('1. 右键 cloudfunctions/uploadIdiomAudio → 上传并部署：云端安装依赖')
  console.log('2. 在小程序开发者工具 Console 粘贴脚本执行')
  console.log('3. 等待完成（约 30~60 分钟）')
}

generate()
