'use strict';
/* ============================================================
   hl-rules.test.js —— 静态检查：每种素材类型是否都有提示词高亮配色
   运行：node --test server/hl-rules.test.js

   为什么要有这个检查：
   提示词里素材名的着色是「类名即类型」——`highlightPrompt` 直接拼出
   `<mark class="hl hl-<素材的 type>">`，配色完全靠 styles.css 里的 `.hl-<type>` 规则。
   于是**少一条规则不会报任何错**：mark 元素照样生成、只是没有颜色，
   表现为"这个类型的素材在提示词里从不着色"。

   2026-09-20 实际状态：`.hl-firstFrame` 与 `.hl-storyboard` 两条规则**根本不存在**
   （首帧图 / 分镜图两类素材名在提示词里一直是无色的），而 `.hl-audio` 存在。
   用户要求"字体颜色根据素材类型自动变换"时，这类静默缺口正是要先堵上的。

   本文件把三份清单钉在一起：
     · 前端 ASSET_TABS（有哪些素材类型）
     · styles.css（每种类型有没有配色）
     · highlightPrompt（生成的类名形状是否仍是 hl-<type>）
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT, 'app', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'app', 'styles.css'), 'utf8');

/* 从 app.js 里取 ASSET_TABS（避免在测试里再抄一份清单 —— 抄一份就会漂移） */
function assetTabs() {
  const m = /const ASSET_TABS = \[([^\]]+)\]/.exec(appJs);
  assert.ok(m, 'app.js 里应当有 const ASSET_TABS = [...]');
  return m[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

test('每一种素材类型都有对应的 .hl-<type> 配色规则', () => {
  const tabs = assetTabs();
  assert.ok(tabs.length >= 6, '素材类型清单看起来不对：' + tabs.join('/'));
  const missing = tabs.filter((t) => !new RegExp('\\.hl-' + t + '\\s*\\{').test(css));
  assert.deepEqual(missing, [],
    '这些素材类型在提示词里不会着色（styles.css 缺 .hl-<type> 规则）：' + missing.join('、') +
    '。加规则或改名都要同步，否则只是静默无色，不会报错。');
});

test('兜底类 .hl-other 必须存在（索引查不到类型时不至于完全无色）', () => {
  assert.match(css, /\.hl-other\s*\{/, 'hl-other 是兜底色，删了会让"查不到类型"的命中变成无色');
});

test('highlightPrompt 生成的类名形状仍是 hl-<type>（与上面的检查同源）', () => {
  assert.match(appJs, /'<mark class="hl hl-'\s*\+\s*esc\(idx\.get\(/,
    'highlightPrompt 的类名形状变了 —— 请同步更新本文件的检查方式');
  assert.match(appJs, /\|\|\s*'other'\)/, '查不到类型时应回落到 other');
});

test('索引键去扩展名：素材名带扩展名时也要能匹配提示词', () => {
  /* 名为「林晚音色.mp3」的素材，若索引键不去扩展名，就永远匹配不到提示词里的「林晚音色」。 */
  assert.match(appJs, /const stripAssetExt = /, '索引应当用去扩展名的键');
  assert.match(appJs, /stripAssetExt\(String\(a\.name/, 'refreshAssetIndex 应当对素材名去扩展名');
});
