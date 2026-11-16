import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addMcpServer,
  installPlugin,
  listAgents,
  listMcpServers,
  listPlugins,
  parseAgentList,
  parseMcpAddCommand,
  parseMcpList,
  parsePluginListJson,
  parsePluginValidationJson,
  removeMcpServer,
  setMcpServerEnabled,
  setPluginEnabled,
  uninstallPlugin,
  validatePlugin,
} from '../src/extensions';

const tempDirs: string[] = [];

async function fakeAgyScript(): Promise<{ cwd: string; executable: string; logFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'agy-ext-'));
  tempDirs.push(dir);
  const logFile = join(dir, 'calls.log');
  const script = join(dir, 'agy-stub');
  await writeFile(script, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(logFile)}
if [[ "$1" == "mcp" && "$2" == "list" ]]; then
  echo "NAME    TYPE   STATUS    COMMAND/URL"
  echo "fetch   stdio  enabled   uvx mcp-server-fetch"
  echo "browser stdio  disabled  npx @playwright/mcp"
elif [[ "$1" == "mcp" && "$2" == "add" ]]; then
  exit 0
elif [[ "$1" == "mcp" && "$2" == "remove" ]]; then
  exit 0
elif [[ "$1" == "plugin" && "$2" == "list" ]]; then
  echo '[{"name":"antislop","enabled":true,"version":"3.2.4","path":"/tmp/p","skills":["antislop","antislop-ui"],"rules":["antislop.md"]}]'
elif [[ "$1" == "plugin" && "$2" == "validate" ]]; then
  if [[ "$3" == *bad-plugin* ]]; then
    echo '{"dir":"/tmp/bad-plugin","name":"bad-plugin","manifest":"plugin.json","components":{"skills":1},"findings":[{"severity":"error","file":"plugin.json","message":"missing version"}]}'
    exit 1
  fi
  echo '{"dir":"/tmp/good-plugin","name":"good-plugin","manifest":"plugin.json","components":{"skills":2},"findings":[]}'
elif [[ "$1" == "plugin" && ( "$2" == "install" || "$2" == "uninstall" ) ]]; then
  exit 0
elif [[ "$1" == "agent" ]]; then
  echo "reviewer  Strict code audit agent"
fi
`, 'utf8');
  await chmod(script, 0o755);
  return { cwd: dir, executable: script, logFile };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});

describe('official agy extension parsers and runners', () => {
  test('parses `agy mcp list` tables and empty notices cleanly', () => {
    expect(parseMcpList('')).toEqual([]);
    expect(parseMcpList('No MCP servers configured.')).toEqual([]);
    expect(parseMcpList([
      'NAME        TYPE   STATUS    COMMAND/URL',
      'fetch       stdio  enabled   uvx mcp-server-fetch',
      'playwright  stdio  disabled  npx -y @playwright/mcp@latest',
      'longname-server stdio disabled npx -y @org/server',
    ].join('\n'))).toEqual([
      { name: 'fetch', type: 'stdio', status: 'enabled', target: 'uvx mcp-server-fetch' },
      { name: 'playwright', type: 'stdio', status: 'disabled', target: 'npx -y @playwright/mcp@latest' },
      { name: 'longname-server', type: 'stdio', status: 'disabled', target: 'npx -y @org/server' },
    ]);
  });

  test('parses `agy plugin list --json` and rejects malformed top-level values', () => {
    expect(parsePluginListJson('')).toEqual([]);
    expect(() => parsePluginListJson('{}')).toThrow('expected array');
    expect(parsePluginListJson(JSON.stringify([
      { name: 'antislop', enabled: true, version: '3.2.4', path: '/p', skills: ['antislop'], rules: ['r.md'] },
      { name: 'disabled-one', enabled: false, path: '/d' },
    ]))).toEqual([
      { name: 'antislop', enabled: true, version: '3.2.4', path: '/p', skills: ['antislop'], rules: ['r.md'] },
      { name: 'disabled-one', enabled: false, path: '/d', skills: [], rules: [] },
    ]);
  });

  test('parses `agy agent` rows cleanly', () => {
    expect(parseAgentList('No agents configured.')).toEqual([]);
    expect(parseAgentList('NAME   DESCRIPTION\nqa     Verification runner')).toEqual([
      { name: 'qa', detail: 'Verification runner' },
    ]);
  });

  test('validates extension names before executing CLI subcommands', async () => {
    const { cwd, executable, logFile } = await fakeAgyScript();
    const opts = { cwd, executable };
    expect(await listMcpServers(opts)).toHaveLength(2);
    expect(await listPlugins(opts)).toHaveLength(1);
    expect(await listAgents(opts)).toEqual([{ name: 'reviewer', detail: 'Strict code audit agent' }]);

    await setMcpServerEnabled(opts, 'browser', true);
    await setPluginEnabled(opts, 'antislop', false);
    await expect(setMcpServerEnabled(opts, '--bad-flag', true)).rejects.toThrow('Invalid MCP server name');
    await expect(setPluginEnabled(opts, 'has space', false)).rejects.toThrow('Invalid plugin name');

    const log = await Bun.file(logFile).text();
    expect(log).toContain('mcp enable browser');
    expect(log).toContain('plugin disable antislop');
  });

  test('parses MCP add specs and manages MCP/plugin lifecycle subcommands safely', async () => {
    expect(parseMcpAddCommand('github npx -y @modelcontextprotocol/server-github')).toEqual({
      name: 'github',
      type: 'stdio',
      commandOrUrl: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
    });
    expect(parseMcpAddCommand('--type http remote "https://example.com/mcp"')).toEqual({
      name: 'remote',
      type: 'http',
      commandOrUrl: 'https://example.com/mcp',
      args: [],
    });
    expect(() => parseMcpAddCommand('only-name')).toThrow('Expected');
    expect(() => parseMcpAddCommand('--type bad name cmd')).toThrow('stdio');

    const parsedValidation = parsePluginValidationJson('{"dir":"/p","name":"demo","components":{"skills":1},"findings":[]}');
    expect(parsedValidation).toEqual({
      dir: '/p',
      name: 'demo',
      components: { skills: 1 },
      findings: [],
    });

    const { cwd, executable, logFile } = await fakeAgyScript();
    const opts = { cwd, executable };
    await addMcpServer(opts, parseMcpAddCommand('docs https://mcp.example.com'));
    await removeMcpServer(opts, 'docs');
    await installPlugin(opts, '/tmp/good-plugin');
    await uninstallPlugin(opts, 'good-plugin');

    const okReport = await validatePlugin(opts, '/tmp/good-plugin');
    expect(okReport.findings).toEqual([]);
    const badReport = await validatePlugin(opts, '/tmp/bad-plugin', true);
    expect(badReport.findings).toEqual([{ severity: 'error', file: 'plugin.json', message: 'missing version' }]);

    await expect(validatePlugin(opts, '--flag')).rejects.toThrow('Invalid plugin path');
    await expect(installPlugin(opts, '--flag')).rejects.toThrow('Invalid plugin install target');

    const log = await Bun.file(logFile).text();
    expect(log).toContain('mcp add --type http docs -- https://mcp.example.com');
    expect(log).toContain('mcp remove docs');
    expect(log).toContain('plugin install /tmp/good-plugin');
    expect(log).toContain('plugin uninstall good-plugin');
    expect(log).toContain('plugin validate /tmp/bad-plugin --json --strict');
  });
});
