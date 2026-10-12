// 下载的文件名 / 文件夹名模板（设置中心的「文件名」）：{title}、{tracknum:02d} 这样的占位符，/ 分隔子文件夹。
// 变量值中的 /、\ 等字符在替换前就清理掉，不会意外地多出一层文件夹（如艺人 AC/DC）。
//
//   formatPath(template, vars) -> ['文件夹', '文件名']   每一段都已是合法的文件名
//   formatName(template, vars) -> string                  各段用 ' - ' 连接（ZIP 名、逐个保存时的文件名）
//   TEMPLATE_VARS                                          可用的变量名（设置页的说明）

export const TEMPLATE_VARS = [
  'title', 'artist', 'album', 'album_artist', 'composer', 'genre', 'tracknum', 'tracktotal', 'disk', 'disktotal',
  'year', 'release_date', 'codec', 'quality', 'bit_depth', 'sample_rate', 'sample_rate_kHz', 'explicit',
  'song_id', 'album_id', 'artist_id', 'isrc', 'upc', 'record_label', 'copyright',
  'playlist', 'playlist_id', 'curator', 'index',
];

const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const MAX_SEGMENT = 180;

/** 一段文件 / 文件夹名：替换非法字符，去掉首尾空白与末尾的点（Windows 不允许），限制长度 */
export function sanitize(name) {
  let s = String(name ?? '').replace(FORBIDDEN, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (RESERVED.test(s)) s = `_${s}`;
  const chars = [...s];
  if (chars.length > MAX_SEGMENT) s = chars.slice(0, MAX_SEGMENT).join('').trim();
  return s || '_';
}

/** 替换一段模板中的占位符：{name} 或 {name:02d}（宽度补零）；不认识的占位符原样保留，方便发现拼写错误 */
function fill(segment, vars) {
  return segment.replace(/\{([A-Za-z_]+)(?::0?(\d{1,2})d)?\}/g, (m, key, width) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return m;
    const value = vars[key];
    if (value === undefined || value === null) return '';
    const text = String(value).replace(FORBIDDEN, '_');
    return width && /^\d+$/.test(text) ? text.padStart(Number(width), '0') : text;
  });
}

export function formatPath(template, vars) {
  const segments = String(template).split('/').map((segment) => fill(segment, vars))
    // 变量为空时留下的多余空白、成对的空括号
    .map((s) => s.replace(/\(\s*\)|\[\s*\]/g, '').replace(/\s+/g, ' ').trim())
    .filter((s) => s && s !== '.' && s !== '..');
  return segments.length ? segments.map(sanitize) : ['_'];
}

export function formatName(template, vars) {
  return formatPath(template, vars).join(' - ');
}
