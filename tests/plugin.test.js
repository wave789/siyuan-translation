const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");

test("keyboard limits Alt to editor selections, ignores combinations and cleans up listeners", async () => {
    const listeners = new Map();
    const editor = {};
    let insideEditor = true;
    const node = { nodeType: 1, closest: () => insideEditor ? editor : null };
    const events = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
    const context = { module: { exports: {} },
        require: name => name === "siyuan" ? {
            Plugin: class { async loadData() { return { shortcut: "alt" }; } addCommand(command) { this.command = command; } },
        } : require("../src/core"),
        document: events,
        window: { ...events, getSelection: () => ({ isCollapsed: false, rangeCount: 1,
            getRangeAt: () => ({ startContainer: node, endContainer: node }), toString: () => "Hello" }) },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve("../src/plugin"), "utf8"), context);
    const plugin = new context.module.exports();
    plugin.setupSettings = () => {};
    let translations = 0;
    plugin.translateSelection = () => { translations++; };
    await plugin.onload();
    assert.equal(plugin.command.hotkey, "⌥T");
    const down = event => listeners.get("keydown")(event);
    const up = () => listeners.get("keyup")({ key: "Alt", preventDefault() {} });
    down({ key: "Alt" }); up(); assert.equal(translations, 1);
    down({ key: "Alt" }); down({ key: "Tab" }); up(); assert.equal(translations, 1);
    down({ key: "Alt" }); down({ key: "Alt", repeat: true }); up(); assert.equal(translations, 1);
    down({ key: "Alt" }); listeners.get("blur")(); up(); assert.equal(translations, 1);
    insideEditor = false;
    down({ key: "Alt" }); up(); assert.equal(translations, 1);
    insideEditor = true; plugin.config.shortcut = "alt-t";
    down({ key: "Alt" }); up(); assert.equal(translations, 1);
    plugin.onunload(); assert.equal(listeners.size, 0);
});

function harness({ load = async () => ({}), dialogFailure = false, translate = async () => "译文" } = {}) {
    const nodes = new Map();
    const messages = [];
    const timers = new Set();
    let instance;
    const events = { addEventListener() {}, removeEventListener() {} };
    const context = { module: { exports: {} }, AbortController,
        setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn),
        document: events, window: events,
        require: name => name === "siyuan" ? {
            Plugin: class { loadData() { return load(); } addCommand() {} },
            showMessage: message => messages.push(message),
            Dialog: class {
                constructor(options) {
                    if (dialogFailure) throw new Error("dialog failed");
                    this.options = options; instance = this;
                    this.element = { querySelector: selector => {
                        if (!nodes.has(selector)) nodes.set(selector, { value: "", textContent: "", disabled: true });
                        return nodes.get(selector);
                    } };
                }
                destroy() { this.options.destroyCallback(); }
            },
        } : { ...require("../src/core"), translate },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve("../src/plugin"), "utf8"), context);
    const plugin = new context.module.exports();
    plugin.setupSettings = () => {};
    plugin.selectedText = () => "Hello";
    return { plugin, nodes, messages, timers, close: () => instance.destroy() };
}

test("configuration load failure recovers and malformed saved values cannot replace defaults", async () => {
    const failed = harness({ load: async () => { throw new Error("storage"); } });
    await failed.plugin.onload();
    assert.equal(failed.plugin.config.provider, "openai");
    assert.equal(failed.messages.length, 1);
    failed.plugin.onunload();
    const malformed = harness({ load: async () => ({ model: null, endpoint: 42, provider: "ollama" }) });
    await malformed.plugin.onload();
    assert.equal(malformed.plugin.config.model, "");
    assert.equal(typeof malformed.plugin.config.endpoint, "string");
    assert.equal(malformed.plugin.config.provider, "ollama");
    malformed.plugin.onunload();
});

test("dialog construction failure clears busy state, request and timer", async () => {
    const h = harness({ dialogFailure: true });
    await h.plugin.onload();
    await h.plugin.translateSelection();
    assert.equal(h.plugin.busy, false);
    assert.equal(h.plugin.controller, null);
    assert.equal(h.timers.size, 0);
    assert.match(h.messages[0], /窗口创建失败/);
    h.plugin.onunload();
});

test("partial translation remains copyable and is never labelled complete", async () => {
    const h = harness({ translate: async () => { throw Object.assign(new Error("译文被截断，尚未完成"), {
        code: "TRANSLATION_TRUNCATED", partialTranslation: "部分译文",
    }); } });
    await h.plugin.onload();
    await h.plugin.translateSelection();
    assert.equal(h.nodes.get("[data-result]").value, "部分译文");
    assert.equal(h.nodes.get("[data-copy]").disabled, false);
    assert.equal(h.nodes.get("[data-copy]").textContent, "复制部分译文");
    assert.match(h.nodes.get('[role="status"]').textContent, /尚未完成/);
    h.plugin.onunload();
});

test("closing an in-flight dialog aborts request and discards late results", async () => {
    let resolve;
    let signal;
    const h = harness({ translate: (_, __, options) => {
        signal = options.signal;
        return new Promise(done => { resolve = done; });
    } });
    await h.plugin.onload();
    const pending = h.plugin.translateSelection();
    h.close();
    assert.equal(signal.aborted, true);
    resolve("late translation");
    await pending;
    assert.equal(h.nodes.get("[data-result]").value, "");
    assert.equal(h.plugin.busy, false);
    assert.equal(h.timers.size, 0);
    h.plugin.onunload();
});
