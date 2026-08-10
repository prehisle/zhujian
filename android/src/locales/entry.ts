// 字典条目形(i18n-plan §1),桌面 src/locales/entry.ts 的安卓孪生:zh/en 并排住同一
// 键下——缺一半是**编译错**,不存在「两份字典键漂移」这类运行期病。分片文件的书写形
// 受门禁约束(check-i18n-drift:一键一行、双引号、无模板串),否则门禁解析不了 =
// 安静的绿。
export type Entry = { readonly zh: string; readonly en: string };

/** 恒等函数,只为让分片文件拿到键名字面量与条目形的双向类型检查。 */
export function defineMessages<T extends Record<string, Entry>>(m: T): T {
  return m;
}
