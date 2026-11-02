// Discord 单条消息最多 2000 字符：优先在换行处切，代码块被切开时在两段各自补上 ``` 保持渲染正确。
export const LIMIT = 1900;

export function splitMessage(text, limit = LIMIT) {
  const parts = [];
  let rest = String(text ?? '').trim();
  if (!rest) return parts;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    let head = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n/, '');
    if ((head.match(/```/g) ?? []).length % 2 === 1) {
      const lang = head.slice(head.lastIndexOf('```') + 3).split('\n', 1)[0];
      head += '\n```';
      rest = '```' + lang + '\n' + rest;
    }
    parts.push(head);
  }
  if (rest) parts.push(rest);
  return parts;
}
