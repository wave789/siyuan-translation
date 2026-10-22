const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { DEFAULTS, md5, buildRequest, parseResult, translate } = require("../src/core");

test("Baidu MD5 matches independent Node implementation including UTF-8 and block boundaries", () => {
    for (const input of ["", "abc", "英文翻译中文🙂", ...[55, 56, 63, 64, 65, 120, 6000].map(n => "a".repeat(n))]) {
        assert.equal(md5(input), createHash("md5").update(input).digest("hex"));
    }
});
test("Baidu signs unencoded text and sends a form body", () => {
    const text = "Hello & world + 中文";
    const request = buildRequest(text, { provider: "baidu", baiduAppId: "123", baiduSecret: "secret" }, "salt");
    const form = new URLSearchParams(request.payload);
    assert.equal(form.get("q"), text);
    assert.equal(form.get("sign"), createHash("md5").update("123" + text + "saltsecret").digest("hex"));
    assert.equal(form.get("to"), "zh");
    assert.ok(!request.url.includes("secret"));
});
test("local model payload supports both protocols and optional authentication", () => {
    for (const provider of ["openai", "ollama"]) {
        const request = buildRequest("Hello", { ...DEFAULTS, provider, model: "local-model", apiKey: "token" });
        assert.equal(request.payload.model, "local-model");
        assert.equal(request.payload.stream, false);
        assert.equal(request.payload.messages[1].content, "Hello");
        assert.deepEqual(request.headers, [{ Authorization: "Bearer token" }]);
    }
    assert.deepEqual(buildRequest("Hello", { ...DEFAULTS, model: "m" }).headers, []);
});
test("reject missing config, unsupported URL and excessive input", () => {
    assert.throws(() => buildRequest("Hi", DEFAULTS), /模型/);
    assert.throws(() => buildRequest("Hi", { provider: "baidu" }), /APP ID/);
    assert.throws(() => buildRequest("Hi", { ...DEFAULTS, endpoint: "file:///etc/passwd" }), /HTTP/);
    assert.throws(() => buildRequest("中".repeat(2001), DEFAULTS), /6000/);
    assert.throws(() => buildRequest(" ", DEFAULTS), /选中/);
});
test("parse all providers and reject empty, truncated, or failed responses", () => {
    assert.equal(parseResult("openai", { choices: [{ message: { content: "你好" } }] }), "你好");
    assert.equal(parseResult("ollama", { message: { content: "你好" } }), "你好");
    assert.equal(parseResult("baidu", { trans_result: [{ dst: "你好" }, { dst: "世界" }] }), "你好\n世界");
    assert.throws(() => parseResult("baidu", { error_code: "54001" }), /签名/);
    assert.throws(() => parseResult("openai", { choices: [{ message: { content: "部分" }, finish_reason: "length" }] }), /截断/);
    assert.throws(() => parseResult("ollama", { message: { content: "" } }), /未返回/);
    assert.throws(() => parseResult("baidu", { trans_result: [{}] }), /格式/);
});
test("proxy sends request to selected service only with cancellation signal", async () => {
    const controller = new AbortController();
    let calls = 0;
    const result = await translate("Hello", { ...DEFAULTS, model: "m" }, {
        signal: controller.signal,
        fetchImpl: async (url, init) => {
            calls++;
            assert.equal(url, "/api/network/forwardProxy");
            assert.equal(init.signal, controller.signal);
            const request = JSON.parse(init.body);
            assert.equal(request.url, DEFAULTS.endpoint);
            assert.equal(request.redirect, false);
            return { ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify({ choices: [{ message: { content: "你好" } }] }) } }) };
        },
    });
    assert.equal(result, "你好"); assert.equal(calls, 1);
});
test("proxy failures do not leak upstream body or fall back to another service", async () => {
    for (const response of [
        { code: -1, msg: "secret" },
        { code: 0, data: { status: 401, body: "secret" } },
        { code: 0, data: { status: 200, body: "secret" } },
    ]) {
        let calls = 0;
        await assert.rejects(translate("Hi", { ...DEFAULTS, model: "m" }, { fetchImpl: async () => {
            calls++; return { ok: true, json: async () => response };
        } }), error => !error.message.includes("secret"));
        assert.equal(calls, 1);
    }
});

test("Ollama generate receives a prompt instead of a chat-only payload", () => {
    const request = buildRequest("Hello", { ...DEFAULTS, provider: "ollama", endpoint: "http://localhost:11434/api/generate", model: "qwen" });
    assert.equal(request.payload.prompt, "Hello");
    assert.ok(request.payload.system.includes("翻译"));
    assert.equal(request.payload.messages, undefined);
    assert.equal(request.payload.stream, false);
    assert.equal(request.payload.think, undefined);
});

test("recognized endpoint takes precedence over a mismatched provider selector", () => {
    const request = buildRequest("Hello", { ...DEFAULTS, provider: "openai", endpoint: "http://localhost:11434/proxy/api/chat/", model: "qwen", ollamaThink: "off" });
    assert.equal(request.payload.messages[1].content, "Hello");
    assert.equal(request.payload.think, false);
    const compatible = buildRequest("Hello", { ...DEFAULTS, provider: "ollama", model: "qwen", ollamaThink: "off" });
    assert.equal(compatible.payload.think, undefined);
    assert.equal(parseResult("openai", { message: { content: "你好" }, done: true }), "你好");
    assert.equal(parseResult("ollama", { choices: [{ message: { content: "你好" } }] }), "你好");
    assert.equal(parseResult("ollama", { response: "你好", done: true }), "你好");
});

test("diagnostics distinguish thinking-only, loading, truncation, and wrong endpoint responses", () => {
    assert.throws(() => parseResult("ollama", { message: { content: "", thinking: "private reasoning" }, done: true }), /仅返回思考/);
    assert.throws(() => parseResult("ollama", { response: "", done_reason: "load" }), /只加载/);
    assert.throws(() => parseResult("ollama", { response: "部分", done_reason: "length" }), /截断/);
    assert.throws(() => parseResult("ollama", { response: "部分", done: false }), /未完成/);
    assert.throws(() => parseResult("ollama", { models: [] }), /模型管理接口/);
    assert.throws(() => parseResult("ollama", null), /JSON 结构/);
    assert.throws(() => parseResult("ollama", { error: "secret" }), error => !error.message.includes("secret") && /服务返回错误/.test(error.message));
});

test("generate translation works end to end through the mocked SiYuan proxy", async () => {
    const result = await translate("Hello", { ...DEFAULTS, provider: "ollama", endpoint: "http://localhost:11434/api/generate", model: "qwen" }, {
        fetchImpl: async (_, init) => {
            const request = JSON.parse(init.body);
            assert.equal(request.payload.prompt, "Hello");
            assert.equal(request.payload.messages, undefined);
            return { ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify({ response: "你好", done: true, done_reason: "stop" }) } }) };
        },
    });
    assert.equal(result, "你好");
});

test("Ollama output budget is explicit, configurable, and confined to native endpoints", () => {
    for (const endpoint of ["http://localhost:11434/api/chat", "http://localhost:11434/api/generate"]) {
        const config = { ...DEFAULTS, endpoint, model: "local", provider: "ollama" };
        assert.deepEqual(buildRequest("Hi", config).payload.options, { num_predict: 4096 });
        assert.deepEqual(buildRequest("Hi", { ...config, ollamaNumPredict: "8192", ollamaThink: "off" }).payload.options, { num_predict: 8192 });
        assert.equal(buildRequest("Hi", { ...config, ollamaNumPredict: "0" }).payload.options, undefined);
        for (const value of ["", "-1", "2.5", "NaN", "Infinity", "131073"]) {
            assert.throws(() => buildRequest("Hi", { ...config, ollamaNumPredict: value }), /最大输出 token/);
        }
    }
    assert.equal(buildRequest("Hi", { ...DEFAULTS, model: "local", ollamaNumPredict: "8192" }).payload.options, undefined);
    const request = buildRequest("Hi", { ...DEFAULTS, provider: "baidu", baiduAppId: "123", baiduSecret: "secret" }, "salt");
    assert.ok(!request.payload.includes("num_predict"));
});

test("truncated text is retained separately and thinking-only output is never a translation", () => {
    for (const data of [
        { message: { content: " 部分译文 ", thinking: "private reasoning" }, done_reason: "length" },
        { response: "部分译文", done_reason: "length" },
        { choices: [{ message: { content: "部分译文" }, finish_reason: "length" }] },
    ]) {
        assert.throws(() => parseResult("ollama", data), error => {
            assert.equal(error.code, "TRANSLATION_TRUNCATED");
            assert.equal(error.partialTranslation, "部分译文");
            assert.match(error.message, /尚未完成/);
            assert.ok(!error.message.includes("private reasoning"));
            return true;
        });
    }
    assert.throws(() => parseResult("ollama", { message: { content: "", thinking: "private reasoning" }, done_reason: "length" }), error => {
        assert.equal(error.partialTranslation, "");
        assert.match(error.message, /思考阶段/);
        assert.match(error.message, /8192/);
        return true;
    });
});

test("malformed proxy and Baidu responses produce actionable errors", async () => {
    assert.throws(() => parseResult("baidu", { trans_result: [null] }), /格式异常/);
    for (const body of [null, { code: 0, data: { body: "{}" } }]) {
        await assert.rejects(translate("Hello", { ...DEFAULTS, model: "m" }, {
            fetchImpl: async () => ({ ok: true, json: async () => body }),
        }), error => !(error instanceof TypeError));
    }
    await assert.rejects(translate("Hello", { ...DEFAULTS, model: "m" }, {
        fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError(); } }),
    }), /无效 JSON/);
});
