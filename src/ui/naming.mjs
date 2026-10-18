// 下载的文件名 / 文件夹名模板（设置中心的「文件名」）：{title}、{tracknum:02d} 这样的占位符，/ 分隔子文件夹。
// 变量值中的 /、\ 等字符在替换前就清理掉，不会意外地多出一层文件夹（如艺人 AC/DC）。
//
//   formatPath(template, vars) -> ['文件夹', '文件名']   每一段都已是合法的文件名
//   formatName(template, vars) -> string                  各段用 ' - ' 连接（ZIP 名、逐个保存时的文件名）
//   fitFolder(segments) / fitFile(folder, segments)        控制路径总长，避免 Windows 260 字符的路径上限
//   TEMPLATE_VARS                                          可用的变量名（设置页的说明）

export const TEMPLATE_VARS = [
  'title', 'artist', 'album', 'album_artist', 'composer', 'genre', 'tracknum', 'tracktotal', 'disk', 'disktotal',
  'year', 'release_date', 'codec', 'quality', 'bit_depth', 'sample_rate', 'sample_rate_kHz', 'explicit',
  'song_id', 'album_id', 'artist_id', 'isrc', 'upc', 'record_label', 'copyright',
  'playlist', 'playlist_id', 'curator', 'index',
];

const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g;
// Chrome 的 File System Access（保存至文件夹）还拒绝 Unicode 格式字符（零宽空格、方向标记等）、非字符、
// 落单的代理项，以及首尾的 ~
const INVISIBLE = /[\p{Cf}\ufdd0-\ufdef\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/gu;
// Windows 设备名（含 COM¹ 这类上标数字）与 Chrome 额外拒绝的 clock$、desktop.ini、thumbs.db
const RESERVED = /^((con|prn|aux|nul|clock\$|(com|lpt)[0-9\u00b9\u00b2\u00b3])(\..*)?|desktop\.ini|thumbs\.db)$/i;
// Chrome 拒绝扩展名为 .lnk、.local 或 .{…}（CLSID）的名字
const SHELL_EXT = /\.(?=(lnk|local|\{.*\})$)/i;
const MAX_SEGMENT = 180;
// macOS / Linux 单个名字最长 255 字节（UTF-8），留出 .m4a、.ttml 等扩展名
const MAX_BYTES = 240;
const utf8 = new TextEncoder();

/** 一段文件 / 文件夹名：替换非法字符，去掉首尾空白与点（Windows / Chrome 不允许），首尾的 ~ 换成全角 ～，限制长度 */
export function sanitize(name) {
  let s = String(name ?? '').replace(FORBIDDEN, '_').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  let chars = [...s];
  if (chars.length > MAX_SEGMENT) chars = chars.slice(0, MAX_SEGMENT);
  while (utf8.encode(chars.join('')).length > MAX_BYTES) chars.pop();
  // 如专辑「A COMPLETE ~ALL SINGLES~」：末尾的 ~ 会让 getDirectoryHandle 报错
  s = chars.join('').replace(/^[.\s]+|[.\s]+$/g, '').replace(/^~|~$/g, '～').replace(SHELL_EXT, '_');
  if (RESERVED.test(s)) s = `_${s}`;
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

// Windows 的完整路径（不含结尾 NUL）最长 259 个 UTF-16 单位，而网页拿不到所选文件夹本身的路径：
// 给它留出约 100 个字符（如 C:\Users\name\OneDrive\Music\Apple Music），其下的相对路径控制在 PATH_BUDGET 以内。
// 专辑文件夹先单独限制在 FOLDER_BUDGET（同一专辑的每首歌都得到相同的文件夹），剩下的给文件名。
const PATH_BUDGET = 150;
const FOLDER_BUDGET = 90;
// 文件名之后还要加的：最长的扩展名 .ttml / .m3u8，以及 Chrome 写入时的临时文件后缀 .crswap
const FILE_SUFFIX = '.ttml.crswap'.length;

const pathLength = (segments) => segments.reduce((n, s) => n + s.length + 1, 0);

/** 每次把最长的一段去掉一个字符，直到总长（含分隔符）不超过 budget */
function shrink(segments, budget) {
  const parts = segments.map((s) => [...s]);
  const length = () => parts.reduce((n, p) => n + p.join('').length + 1, 0);
  while (length() > budget) {
    const longest = parts.reduce((a, b) => (b.join('').length > a.join('').length ? b : a));
    if (longest.length <= 1) break;
    longest.pop();
  }
  return parts.map((p) => sanitize(p.join('')));
}

export function fitFolder(segments) {
  return pathLength(segments) > FOLDER_BUDGET ? shrink(segments, FOLDER_BUDGET) : segments;
}

/** 文件的各段（最后一段尚未加扩展名）：与所在文件夹合起来不超过 PATH_BUDGET */
export function fitFile(folder, segments) {
  const budget = Math.max(PATH_BUDGET - pathLength(folder) - FILE_SUFFIX, segments.length * 2);
  return pathLength(segments) > budget ? shrink(segments, budget) : segments;
}
