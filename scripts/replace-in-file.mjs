// 对超长单行文件(CLAUDE.md 的段落行 >25k token,Read/Edit 工具读不了)做精确替换。
// old/new 串放文件里传入,避免命令行转义;indexOf 校验「必须恰好命中一次」,不唯一即拒。
// 用法:node scripts/replace-in-file.mjs <目标文件> <old串文件> <new串文件>
// 注意:old/new 文件须 UTF-8 无 BOM、不带多余的尾随换行(写入时按原样匹配)。
import fs from 'fs';
const [, , target, oldFile, newFile] = process.argv;
if (!target || !oldFile || !newFile) {
  console.error('用法: node replace-in-file.mjs <target> <oldFile> <newFile>');
  process.exit(1);
}
const content = fs.readFileSync(target, 'utf8');
const oldStr = fs.readFileSync(oldFile, 'utf8');
const newStr = fs.readFileSync(newFile, 'utf8');
const first = content.indexOf(oldStr);
if (first === -1) {
  console.error('NOT FOUND');
  process.exit(1);
}
if (content.indexOf(oldStr, first + 1) !== -1) {
  console.error('NOT UNIQUE');
  process.exit(1);
}
fs.writeFileSync(target, content.slice(0, first) + newStr + content.slice(first + oldStr.length));
console.log('OK replaced', oldStr.length, '->', newStr.length, 'chars');
