/* =====================================================================
 * sync.js — 统一存储层（GitHub Gist 后端 + 本地缓存兜底）
 * 纯前端，无自建服务器。数据真相源 = 用户 GitHub 账号下的一个私有 Gist。
 *
 * 配置（仅存浏览器 localStorage，不经过任何第三方服务器）：
 *   safe_plan_gh_token : GitHub Personal Access Token（需 gist 权限）
 *   safe_plan_gh_gist  : 同步用 Gist 的 id（首次自动创建并保存）
 *
 * 同步规则：
 *   - 未配置 token：退化为纯本地（localStorage），功能不受影响。
 *   - 已配置 token：initSync 拉取 Gist 覆盖本地（远端优先 / 真相源）；
 *     save() 写本地 + 防抖推送（推送前先拉最新远端，本地修改覆盖远端对应 key）。
 *   - 离线 / 令牌失效：静默降级本地，恢复后下次 save 自动重试。
 * ===================================================================== */
const NS = 'safe_plan_';
const GH_API = 'https://api.github.com';
const GIST_FILE = 'safe_plan_data.json';
const _cache = Object.create(null);
let _ready = false;
let _cbs = [];

function _parse(s){ try { return JSON.parse(s); } catch(e){ return undefined; } }

function cfg(){
  return {
    token: localStorage.getItem(NS + 'gh_token') || '',
    gist:  localStorage.getItem(NS + 'gh_gist')  || ''
  };
}
function setCfg(token, gist){
  if (token) localStorage.setItem(NS + 'gh_token', token);
  if (gist) localStorage.setItem(NS + 'gh_gist', gist);
}
function hasCfg(){ return !!cfg().token; }

/* 同步读取：initSync 完成前返回本地值（不阻塞、不丢数据） */
function load(k, def){
  let v;
  if (Object.prototype.hasOwnProperty.call(_cache, k)) v = _cache[k];
  else {
    const raw = localStorage.getItem(NS + k);
    v = (raw === null) ? undefined : _parse(raw);
  }
  if (v === undefined) return def;
  if (Array.isArray(def)) return Array.isArray(v) ? v : def;
  return v;
}
function saveLocal(k, v){
  _cache[k] = v;
  try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch(e){}
}
function save(k, v){
  saveLocal(k, v);
  schedulePush(k);
}

/* ---------- GitHub 通信 ---------- */
async function gh(path, opts){
  const c = cfg();
  if (!c.token) throw new Error('NO_TOKEN');
  opts = opts || {};
  opts.headers = Object.assign({
    'Authorization': 'token ' + c.token,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json'
  }, opts.headers || {});
  const r = await fetch(GH_API + path, opts);
  if (!r.ok) throw new Error('GH_' + r.status);
  return r;
}
async function readGist(){
  const c = cfg();
  if (!c.gist) await ensureGist();
  const r = await gh('/gists/' + cfg().gist);
  const data = await r.json();
  const f = data.files && data.files[GIST_FILE];
  try { return JSON.parse((f && f.content) || '{}') || {}; } catch(e){ return {}; }
}
async function writeGist(obj){
  await gh('/gists/' + cfg().gist, {
    method: 'PATCH',
    body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(obj) } } })
  });
}
async function ensureGist(){
  const c = cfg();
  if (c.gist) return;
  const r = await gh('/gists', {
    method: 'POST',
    body: JSON.stringify({ description: 'safe_plan_sync', public: false, files: { [GIST_FILE]: { content: '{}' } } })
  });
  const data = await r.json();
  setCfg(c.token, data.id);
}

/* ---------- 推送（防抖 + 失败重试） ---------- */
let _q = {};
let _timer = null;
function schedulePush(key){
  if (!hasCfg()) return;
  _q[key] = true;
  if (_timer) return;
  _timer = setTimeout(flush, 700);
}
async function flush(){
  _timer = null;
  const keys = Object.keys(_q); _q = {};
  if (!hasCfg()) return;
  try {
    const remote = await readGist();
    keys.forEach(k=>{
      const raw = localStorage.getItem(NS + k);
      if (raw !== null) remote[k] = _parse(raw);
    });
    await writeGist(remote);
  } catch(e){
    keys.forEach(k=> _q[k] = true);          // 失败重新入队
    if (!_timer) _timer = setTimeout(flush, 3000);
  }
}

/* ---------- 初始化 ---------- */
async function initSync(){
  if (!hasCfg()){
    _ready = true;
    _cbs.splice(0).forEach(f=>f());
    document.dispatchEvent(new Event('syncready'));
    return;
  }
  try {
    const remote = await readGist();
    Object.keys(remote).forEach(k=>{
      if (k === 'gh_token' || k === 'gh_gist') return;
      saveLocal(k, remote[k]);
    });
  } catch(e){ /* 离线 / 令牌无效：用本地 */ }
  _ready = true;
  _cbs.splice(0).forEach(f=>f());
  document.dispatchEvent(new Event('syncready'));
}

function runWhenReady(fn){
  if (_ready) fn();
  else _cbs.push(fn);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSync, { once:true });
else initSync();
