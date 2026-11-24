/**
 * 【户部·协曹】双端协同「EQ 建议码」编解码与可读清单生成
 * ---------------------------------------------------------------------------
 * 手机（测量端）把拟合出的参量 EQ 频段编码成一段紧凑单行文本，
 * 用户复制到电脑（播放端）粘贴导入即可应用 EQ，两端无需联网。
 *
 * 建议码固定 5 段，以 | 分隔：
 *   SEQ1|<targetId>|<tilt>|<bass>|<bands>
 * bands 段内每个频段以 ; 分隔，字段以 , 分隔，顺序为 type,freq,gain,q,enabled。
 * meta 中的 mode / fitRms 属于展示用的软信息（可读清单标题会用到），
 * 按紧凑格式不写入建议码；解码时以默认值填充。
 *
 * 纯 ES module、全部具名导出、零副作用、不修改入参、所有数值输出有限。
 */
import { EQ_LIMITS } from '../contracts.js';

/* ------------------------------ 协同模式常量 ------------------------------ */

/** 协同模式标准扫频时长（秒） */
export const SYNC_SWEEP_SEC = 5;
/** 循环扫频之间的静音间隔（秒） */
export const SYNC_GAP_SEC = 1.5;
/** 循环粉噪缓冲区长度（秒） */
export const SYNC_PINK_SEC = 10;
/** 扫频起始频率（Hz） */
export const SYNC_F1 = 20;
/** 扫频结束频率（Hz） */
export const SYNC_F2 = 20000;

/* ------------------------------ 内部常量 ------------------------------ */

const VERSION = 'SEQ1';
const DEFAULT_TARGET_ID = 'flat';
const DEFAULT_MODE = 'sweep';

const TYPE_TO_CODE = Object.freeze({ peaking: 'p', lowshelf: 'l', highshelf: 'h' });
const CODE_TO_TYPE = Object.freeze({ p: 'peaking', l: 'lowshelf', h: 'highshelf' });
const TYPE_LABEL = Object.freeze({ peaking: '峰值', lowshelf: '低架', highshelf: '高架' });

/* ------------------------------ 内部工具 ------------------------------ */

/** 有限数保护：非有限值回退到 fallback。 */
function finiteOr(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/** 钳制到 [lo, hi]；非有限输入先回退到 fallback，保证结果有限。 */
function clamp(v, lo, hi, fallback) {
  const n = Number.isFinite(v) ? v : fallback;
  return n < lo ? lo : (n > hi ? hi : n);
}

/** 固定小数位字符串；消除负零，避免出现 "-0.00" 一类的输出。 */
function fixed(v, digits) {
  const s = finiteOr(v, 0).toFixed(digits);
  return Number(s) === 0 ? (0).toFixed(digits) : s;
}

/** 解析数字文本；空串、NaN、Infinity 一律返回 NaN，便于统一判非法。 */
function parseNum(s) {
  const t = String(s).trim();
  if (t === '') return NaN;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/** 清洗目标曲线标识：仅保留可打印 ASCII、去掉 | 与 ,、空值回退默认值。 */
function cleanTargetId(v) {
  const s = typeof v === 'string' ? v : '';
  const cleaned = s.replace(/[^\x21-\x7e]/g, '').replace(/[|,]/g, '');
  return cleaned || DEFAULT_TARGET_ID;
}

/** 每次返回全新的 meta 对象，避免共享可变状态造成副作用。 */
function defaultMeta() {
  return {
    targetId: DEFAULT_TARGET_ID,
    tilt: 0,
    bass: 0,
    mode: DEFAULT_MODE,
    fitRms: null,
  };
}

/** 构造解析失败结果：频段为空、meta 为默认值、附中文说明。 */
function fail(meta, error) {
  return { ok: false, bands: [], meta, error };
}

/** 安全取 meta 对象，兼容 null / 非对象入参。 */
function metaOf(meta) {
  return meta && typeof meta === 'object' ? meta : {};
}

/** 频率显示：1 位小数并去掉 ".0" 尾缀（120.0 -> 120）。 */
function fmtFreq(v) {
  return finiteOr(v, EQ_LIMITS.fMin).toFixed(1).replace(/\.0$/, '');
}

/** 增益显示：1 位小数、正数带 + 号、负零归一。 */
function fmtGain(v) {
  const n = Number(finiteOr(v, 0).toFixed(1));
  return (n > 0 ? '+' : '') + (n === 0 ? 0 : n).toFixed(1);
}

/* ------------------------------ 编码 ------------------------------ */

/**
 * 把 EQ 频段编码成紧凑单行建议码。
 * 数值先按 EQ_LIMITS 钳制再编码；最多取前 maxBands 个频段；
 * 空频段列表时第 5 段为空字符串。不修改入参数组。
 * @param {Array} bands 参量 EQ 频段数组
 * @param {{targetId?:string, tilt?:number, bass?:number, mode?:string, fitRms?:number}} meta 附加信息
 * @returns {string} 形如 "SEQ1|harman-speaker|0.00|0.00|p,120.0,3.5,1.20,1;..."
 */
export function encodeAdvice(bands, meta = {}) {
  const m = metaOf(meta);
  const targetId = cleanTargetId(m.targetId);
  const tilt = fixed(m.tilt, 2);
  const bass = fixed(m.bass, 2);

  const list = Array.isArray(bands) ? bands : [];
  const limit = EQ_LIMITS.maxBands;
  const parts = [];
  for (let i = 0; i < list.length && i < limit; i++) {
    const b = list[i] && typeof list[i] === 'object' ? list[i] : {};
    const type = TYPE_TO_CODE[b.type] || 'p';
    const freq = clamp(b.freq, EQ_LIMITS.fMin, EQ_LIMITS.fMax, EQ_LIMITS.fMin);
    const gain = clamp(b.gain, EQ_LIMITS.gainMin, EQ_LIMITS.gainMax, 0);
    const q = clamp(b.q, EQ_LIMITS.qMin, EQ_LIMITS.qMax, EQ_LIMITS.qMin);
    const enabled = b.enabled ? 1 : 0;
    parts.push([type, fixed(freq, 1), fixed(gain, 1), fixed(q, 2), enabled].join(','));
  }

  return [VERSION, targetId, tilt, bass, parts.join(';')].join('|');
}

/* ------------------------------ 解码 ------------------------------ */

/**
 * 解析建议码；任何非法输入都返回 ok:false 与中文 error，绝不抛异常。
 * 成功时 bands 不含 id、按 freq 升序，最多 EQ_LIMITS.maxBands 个。
 * @param {string} code 单行建议码
 * @returns {{ok:boolean, bands:Array<{type,freq,gain,q,enabled}>, meta:{targetId,tilt,bass,mode,fitRms}, error?:string}}
 */
export function decodeAdvice(code) {
  const meta = defaultMeta();
  if (typeof code !== 'string' || code.trim() === '') {
    return fail(meta, '建议码为空或不是文本');
  }

  const seg = code.trim().split('|');
  if (seg[0] !== VERSION) {
    return fail(meta, `第 1 段版本前缀必须为 ${VERSION}，实际为「${seg[0]}」`);
  }
  if (seg.length < 5) {
    return fail(meta, `建议码字段不足：至少需要 5 段，实际只有 ${seg.length} 段`);
  }

  const targetId = seg[1];
  if (!targetId || targetId.trim() === '') {
    return fail(meta, '第 2 段目标曲线标识为空');
  }
  if (targetId.indexOf(',') !== -1) {
    return fail(meta, '第 2 段目标曲线标识不得包含逗号');
  }

  const tilt = parseNum(seg[2]);
  if (!Number.isFinite(tilt)) {
    return fail(meta, '第 3 段倾斜量不是有效数字');
  }
  const bass = parseNum(seg[3]);
  if (!Number.isFinite(bass)) {
    return fail(meta, '第 4 段低频量不是有效数字');
  }

  const bandStr = seg[4];
  const bands = [];
  if (bandStr.trim() !== '') {
    const chunks = bandStr.split(';');
    if (chunks.length > EQ_LIMITS.maxBands) {
      return fail(meta, `频段数量超过上限 ${EQ_LIMITS.maxBands} 个，实际有 ${chunks.length} 个`);
    }
    for (let i = 0; i < chunks.length; i++) {
      const n = i + 1;
      const fields = chunks[i].split(',');
      if (fields.length !== 5) {
        return fail(meta, `第 ${n} 个频段字段数应为 5，实际为 ${fields.length}`);
      }
      const type = CODE_TO_TYPE[fields[0]];
      if (!type) {
        return fail(meta, `第 ${n} 个频段类型「${fields[0]}」非法，只能是 p / l / h`);
      }
      const freq = parseNum(fields[1]);
      const gain = parseNum(fields[2]);
      const q = parseNum(fields[3]);
      if (!Number.isFinite(freq) || freq < 10 || freq > 24000) {
        return fail(meta, `第 ${n} 个频段频率超出合理范围（10..24000 Hz）`);
      }
      if (!Number.isFinite(gain) || gain < -24 || gain > 24) {
        return fail(meta, `第 ${n} 个频段增益超出合理范围（-24..24 dB）`);
      }
      if (!Number.isFinite(q) || q < 0.1 || q > 20) {
        return fail(meta, `第 ${n} 个频段 Q 超出合理范围（0.1..20）`);
      }
      if (fields[4] !== '0' && fields[4] !== '1') {
        return fail(meta, `第 ${n} 个频段启用标志必须为 0 或 1`);
      }
      bands.push({ type, freq, gain, q, enabled: fields[4] === '1' });
    }
  }

  bands.sort((a, b) => a.freq - b.freq);
  return {
    ok: true,
    bands,
    meta: { targetId, tilt, bass, mode: DEFAULT_MODE, fitRms: null },
  };
}

/* ------------------------------ 可读清单 ------------------------------ */

/**
 * 生成人可读的多行建议清单（中文）：标题行、表头、分隔线、各频段行、末尾提示。
 * 每行一个频段，形如 "01  峰值   120 Hz   +3.5 dB   Q 1.20"，
 * 禁用频段在行尾标注「（已禁用）」。纯文本、不含 HTML，不修改入参数组。
 * @param {Array} bands 参量 EQ 频段数组
 * @param {{targetId?:string, tilt?:number, bass?:number, mode?:string, fitRms?:number}} meta 附加信息
 * @returns {string}
 */
export function formatAdviceText(bands, meta = {}) {
  const m = metaOf(meta);
  const list = Array.isArray(bands) ? bands : [];
  const targetId = cleanTargetId(m.targetId);
  const rms = typeof m.fitRms === 'number' && Number.isFinite(m.fitRms)
    ? m.fitRms.toFixed(2) + ' dB'
    : '—';
  const divider = '------------------------------------------------------------';

  const lines = [];
  lines.push('EQ 调校建议清单');
  lines.push(`目标曲线: ${targetId}    频段数: ${list.length}    拟合残差: ${rms}`);
  lines.push('');
  lines.push('序号  类型   频率        增益        Q');
  lines.push(divider);

  if (list.length === 0) {
    lines.push('（无 EQ 频段，当前为直通）');
  } else {
    for (let i = 0; i < list.length; i++) {
      const b = list[i] && typeof list[i] === 'object' ? list[i] : {};
      const idx = String(i + 1).padStart(2, '0');
      const label = TYPE_LABEL[b.type] || '未知';
      const disabled = b.enabled === false ? '  （已禁用）' : '';
      lines.push(
        `${idx}  ${label}   ${fmtFreq(b.freq)} Hz   ${fmtGain(b.gain)} dB   Q ${fixed(b.q, 2)}${disabled}`
      );
    }
  }

  lines.push(divider);
  lines.push('提示：导入后请结合实际听感微调各频段增益与 Q 值，必要时可停用个别频段。');
  return lines.join('\n');
}

/* ------------------------------ 完整传输文本 ------------------------------ */

/**
 * 生成可一键复制的完整文本 = 操作指引 + 可读清单 + 建议码。
 * 建议码独占最后一行，前缀严格为 "建议码: "，便于 extractAdviceCode 提取。
 * @param {Array} bands 参量 EQ 频段数组
 * @param {{targetId?:string, tilt?:number, bass?:number, mode?:string, fitRms?:number}} meta 附加信息
 * @returns {string}
 */
export function buildTransferText(bands, meta = {}) {
  const guide =
    '双端协同 EQ 建议 · 测量端 → 播放端\n' +
    '\n' +
    '操作指引：\n' +
    '在电脑端打开本应用 → 切换到『播放端 · 电脑』→ 把下方建议码粘贴到导入框 → 点击『导入并应用 EQ』\n' +
    '\n';
  return guide + formatAdviceText(bands, meta) + '\n\n建议码: ' + encodeAdvice(bands, meta);
}

/* ------------------------------ 码提取 ------------------------------ */

/**
 * 从用户粘贴的任意文本中提取建议码；容忍前后空白、说明文字、多行与 \r\n。
 * 优先取以「建议码:」/「建议码：」开头的行，其次在全文匹配首个 SEQ1|... 片段。
 * @param {string} text 任意粘贴文本
 * @returns {string|null} 找不到返回 null
 */
export function extractAdviceCode(text) {
  if (typeof text !== 'string') return null;

  const lines = text.split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*建议码\s*[：:]\s*(SEQ1\|[^\s]+)/);
    if (m) return m[1];
  }

  const any = text.match(/SEQ1\|[^\s]+/);
  return any ? any[0] : null;
}
