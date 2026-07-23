import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Meal Agent review prototype", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Meal Agent · 低保真原型<\/title>/i);
  assert.match(html, /先从今晚这一顿开始/);
  assert.match(html, /技术验证产品基线/);
  assert.match(html, /少填、快比、可确认/);
  assert.match(html, /首次引导/);
  assert.match(html, /建议组合与加菜/);
  assert.match(html, /库存扣减与回库/);
  assert.match(html, /当前页面状态模拟/);
  assert.match(html, /安全阻断/);
  assert.match(html, /重复提交/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("removes starter-only preview code and keeps review content explicit", async () => {
  const [page, layout, packageJson, readme, sitesPlugin] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../build/sites-vite-plugin.ts", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /_sites-preview|SkeletonPreview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(layout, /openGraph/);
  assert.match(layout, /og\.png/);
  assert.match(page, /评审工具：模拟家人刚更新库存/);
  assert.match(page, /确认后才会写入库存消耗事件/);
  assert.match(page, /今晚建议做/);
  assert.match(page, /系统建议 · 已预选/);
  assert.match(page, /可选菜 · 按需增减/);
  assert.match(page, /每次增减都会重算整餐时间、采购项与库存消耗/);
  assert.doesNotMatch(page, /生成三个不同目标的方案/);
  assert.match(page, /生鸡肉 · 约 1 盒/);
  assert.match(page, /不提供“尽量利用”入口/);
  assert.match(page, /入库后不会继续停留在“待入库”/);
  assert.match(page, /stockable: false/);
  assert.match(page, /采购已完成，回到菜单准备做饭/);
  assert.match(page, /本餐已记录，不会重复写入/);
  assert.match(page, /带着当前共享清单问 Agent/);
  assert.match(page, /步骤进度已保存/);
  assert.match(page, /当前组合还不能确认/);
  assert.match(page, /status: "stocked"/);
  assert.doesNotMatch(page, /\.purchased\b/);
  assert.match(readme, /它不是正式客户端/);
  assert.match(sitesPlugin, /hosting\.json/);
});
