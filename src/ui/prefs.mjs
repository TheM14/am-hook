// 设置中心（/settings，views/settings.mjs）的存储：下载设置，以及之后的播放设置等。
// 保存在 localStorage（不会过期），同一浏览器的其他标签页修改后自动同步。
//
//   prefs.get(section)          该分组的当前设置（已合并默认值、校验过的副本）
//   prefs.set(section, patch)   修改并保存，通知 onChange
//   prefs.reset(section)        恢复默认
//   prefs.onChange(fn)          设置变化后回调 fn(section, value)，返回取消订阅的函数
//   DEFAULTS / OPTIONS          默认值与各选项的可选值（设置页据此渲染）

const STORAGE_KEY = 'am-hook:settings';

/** iTunes 标签中可选写入的字段（与 amd.wol.moe 的「嵌入标签字段」相同） */
export const TAG_FIELDS = [
  'title', 'artist', 'album', 'album_artist', 'composer', 'genre', 'created', 'tracknum', 'disk',
  'lyrics', 'cover', 'copyright', 'record_company', 'upc', 'isrc', 'rtng', 'song_id', 'album_id', 'artist_id',
];

export const OPTIONS = {
  download: {
    // 首选音质；没有时按 fallback 降级
    codec: ['alac', 'atmos', 'aac', 'aac-binaural', 'aac-downmix', 'aac-he'],
    alacMax: [192000, 96000, 48000, 44100],
    atmosMax: [2768, 2448],
    saveMode: ['zip', 'folder', 'files'],
    coverFormat: ['jpg', 'png', 'original'],
    lyricsFormat: ['lrc', 'ttml'],
  },
};

export const DEFAULTS = {
  download: {
    codec: 'alac',
    alacMax: 192000,
    atmosMax: 2768,
    // 首选音质不存在时改用次一级（否则跳过该曲目）
    fallback: true,
    // 同时下载的曲目数；每首歌内部另有 4 路分段并发
    concurrency: 2,
    // 失败后自动重试的次数
    retries: 2,
    // 用浏览器文件系统（OPFS）暂存，内存占用与专辑大小无关
    opfs: true,
    // zip：整张专辑 / 歌单打包为一个 ZIP；folder：写入选定的本地文件夹（File System Access API）；files：逐个文件保存
    saveMode: 'zip',
    // 保存到文件夹时跳过已存在的文件
    skipExisting: true,
    // 为歌单另存 .m3u8 播放列表
    m3u: true,
    // 文件夹 / ZIP 名与文件名模板；文件名模板中的 / 表示子文件夹
    albumFolder: '{album_artist} - {album}',
    playlistFolder: '{playlist}',
    songFile: '{disk}-{tracknum:02d} {title}',
    playlistFile: '{index:02d}. {artist} - {title}',
    singleFile: '{artist} - {title}',
    // 标签
    embed: [...TAG_FIELDS],
    sortTags: false,
    // 歌单中的曲目写入原专辑信息（专辑名、曲目号等）；关闭时专辑为歌单名、曲目号为歌单中的序号
    playlistAlbumInfo: true,
    // 元数据（歌名、专辑名等）的语言；空为跟随曲库语言
    metaLang: '',
    // 封面
    coverFormat: 'jpg',
    coverSize: 3000,
    saveCover: true,
    // 歌词
    saveLyrics: false,
    lyricsFormat: 'lrc',
    syllable: false,
    lyricsTranslation: true,
    lyricsPronunciation: false,
    // wrapper-lite /lyrics 的 language；空为跟随元数据语言
    lyricsLang: '',
  },
};

const LANG_TAG = /^[A-Za-z0-9-]{0,35}$/;
const int = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const template = (v, fallback) => (typeof v === 'string' && v.trim() && v.length <= 300 ? v : fallback);

/** 合并默认值并逐项校验：localStorage 里的值可能来自旧版本或被手动改过 */
function clean(section, raw) {
  const d = DEFAULTS[section];
  const r = raw && typeof raw === 'object' ? raw : {};
  if (section !== 'download') return { ...d, ...r };
  const o = OPTIONS.download;
  return {
    codec: oneOf(r.codec, o.codec, d.codec),
    alacMax: oneOf(Number(r.alacMax), o.alacMax, d.alacMax),
    atmosMax: oneOf(Number(r.atmosMax), o.atmosMax, d.atmosMax),
    fallback: bool(r.fallback, d.fallback),
    concurrency: int(r.concurrency, 1, 6, d.concurrency),
    retries: int(r.retries, 0, 5, d.retries),
    opfs: bool(r.opfs, d.opfs),
    saveMode: oneOf(r.saveMode, o.saveMode, d.saveMode),
    skipExisting: bool(r.skipExisting, d.skipExisting),
    m3u: bool(r.m3u, d.m3u),
    albumFolder: template(r.albumFolder, d.albumFolder),
    playlistFolder: template(r.playlistFolder, d.playlistFolder),
    songFile: template(r.songFile, d.songFile),
    playlistFile: template(r.playlistFile, d.playlistFile),
    singleFile: template(r.singleFile, d.singleFile),
    embed: Array.isArray(r.embed) ? TAG_FIELDS.filter((f) => r.embed.includes(f)) : [...d.embed],
    sortTags: bool(r.sortTags, d.sortTags),
    playlistAlbumInfo: bool(r.playlistAlbumInfo, d.playlistAlbumInfo),
    metaLang: typeof r.metaLang === 'string' && LANG_TAG.test(r.metaLang.trim()) ? r.metaLang.trim() : d.metaLang,
    coverFormat: oneOf(r.coverFormat, o.coverFormat, d.coverFormat),
    coverSize: int(r.coverSize, 100, 10000, d.coverSize),
    saveCover: bool(r.saveCover, d.saveCover),
    saveLyrics: bool(r.saveLyrics, d.saveLyrics),
    lyricsFormat: oneOf(r.lyricsFormat, o.lyricsFormat, d.lyricsFormat),
    syllable: bool(r.syllable, d.syllable),
    lyricsTranslation: bool(r.lyricsTranslation, d.lyricsTranslation),
    lyricsPronunciation: bool(r.lyricsPronunciation, d.lyricsPronunciation),
    lyricsLang: typeof r.lyricsLang === 'string' && LANG_TAG.test(r.lyricsLang.trim()) ? r.lyricsLang.trim() : d.lyricsLang,
  };
}

function load() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch {}
  return Object.fromEntries(Object.keys(DEFAULTS).map((section) => [section, clean(section, raw[section])]));
}

let state = load();
const listeners = new Set();

function store() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

function emit(section) {
  for (const fn of listeners) fn(section, get(section));
}

function get(section) {
  const value = state[section];
  return { ...value, ...(value.embed ? { embed: [...value.embed] } : {}) };
}

export const prefs = {
  get,
  set(section, patch) {
    state = { ...state, [section]: clean(section, { ...state[section], ...patch }) };
    store();
    emit(section);
    return get(section);
  },
  reset(section) {
    state = { ...state, [section]: clean(section, null) };
    store();
    emit(section);
    return get(section);
  },
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

// 其他标签页修改后同步
addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return;
  const before = JSON.stringify(state);
  state = load();
  if (JSON.stringify(state) !== before) for (const section of Object.keys(DEFAULTS)) emit(section);
});
