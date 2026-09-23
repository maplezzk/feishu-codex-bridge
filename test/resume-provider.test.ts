import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';

// 最小假 codex app-server：把 thread/resume 的请求参数落到文件，并按实际参数回
// modelProvider（codex 真实行为：不传就沿用会话里记的那个）。POSIX shebang 脚本，
// Windows 跳过（被测代码本身是平台无关的）。
const FAKE_SERVER = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
let buf = '';
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (typeof msg.id !== 'number') continue; // notification — ignore
    if (msg.method === 'thread/resume') {
      fs.writeFileSync(path.join(__dirname, 'resume-params.json'), JSON.stringify(msg.params));
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          thread: { id: msg.params.threadId },
          model: msg.params.model ?? 'session-model',
          modelProvider: msg.params.modelProvider ?? 'openai',
          cwd: msg.params.cwd,
        },
      });
      continue;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
setInterval(() => {}, 1 << 30); // stay alive until killed
`;

const dir = mkdtempSync(join(tmpdir(), 'resume-provider-'));
const bin = join(dir, 'codex');
const paramsFile = join(dir, 'resume-params.json');
writeFileSync(bin, FAKE_SERVER, { mode: 0o755 });

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Env {
  CODEX_BIN?: string;
  CODEX_HOME?: string;
}

async function withEnv<T>(env: Env, fn: () => Promise<T>): Promise<T> {
  const prev = { CODEX_BIN: process.env.CODEX_BIN, CODEX_HOME: process.env.CODEX_HOME };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function resumeOnce(): Promise<Record<string, unknown>> {
  const backend = new CodexAppServerBackend();
  const thread = await backend.resumeThread({ sessionId: '01session', cwd: dir });
  try {
    return JSON.parse(readFileSync(paramsFile, 'utf8')) as Record<string, unknown>;
  } finally {
    await thread.close().catch(() => undefined);
  }
}

describe.skipIf(process.platform === 'win32')('resume 按当前 config 覆盖会话 provider', () => {
  it('sends the top-level model_provider from config.toml as modelProvider', async () => {
    const home = mkdtempSync(join(tmpdir(), 'resume-provider-home-'));
    writeFileSync(join(home, 'config.toml'), 'model_provider = "cider"\nmodel = "deepseek-flash"\n');
    rmSync(paramsFile, { force: true });
    try {
      const params = await withEnv({ CODEX_BIN: bin, CODEX_HOME: home }, resumeOnce);
      expect(params.modelProvider).toBe('cider');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('omits modelProvider when config.toml sets no top-level provider', async () => {
    const home = mkdtempSync(join(tmpdir(), 'resume-provider-home-'));
    writeFileSync(join(home, 'config.toml'), '[model_providers.cider]\nmodel_provider = "cider"\n');
    rmSync(paramsFile, { force: true });
    try {
      const params = await withEnv({ CODEX_BIN: bin, CODEX_HOME: home }, resumeOnce);
      expect('modelProvider' in params).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
