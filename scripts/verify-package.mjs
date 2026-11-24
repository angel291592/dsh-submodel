#!/usr/bin/env node
// scripts/verify-package.mjs —— 发布包门禁、内容摘要与 Git 原始 blob 物化
//
// 用法：
//   node scripts/verify-package.mjs <候选.tgz> [--json] [--expect-content-sha256 <hex>]
//   node scripts/verify-package.mjs --materialize <空目录或不存在目录> [--rev <提交>] [--json]
//
// 职责（对应统一版计划 §7.1）：
//   1) 读取真实 tar 文件（gzip + tar 流，不依赖外部 tar 命令）：先验证规范路径、重复、
//      文件类型（仅普通文件；拒绝链接、目录、设备等）与结束后无多余数据，再按内容检查
//      版本、入口、导出和隐私项。允许项缺一或多一均失败。
//   2) --materialize 把“核对过的 Git 树”里的允许项按原始 blob 字节写入隔离目录，供
//      npm pack 使用。绝不用工作树/checkout 内容：core.autocrlf 会在 Windows 上把 LF
//      转成 CRLF，导致内容摘要与公开仓不一致。
//   3) 记录 tarball SHA256 与按路径排序的“路径＋文件字节 SHA256”内容摘要；同一算法同时
//      用于物化结果与 tarball，release.ps1 和 release 工作流据此比对同一内容。
//
// 摘要契约（本文件是唯一定义）：
//   pack-content-sha256 = SHA256( 按相对路径排序（UTF-8 字节序）的每行
//                                  "<相对路径>\n<该文件字节的 SHA256 小写十六进制>\n" )
//   tarball-sha256      = SHA256(整个 .tgz 文件字节)
//
// 输出约束：隐私项只打印类别与公开路径，绝不打印命中的敏感值；出错时退出码为 1。
// 候选契约：统一版 0.4.0（计划 §7.1）。后续版本需同步改本文件的 EXPECTED 与允许项。

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const EXPECTED = {
  name: 'dsh-submodel',
  version: '0.4.0',
  main: 'lib/index.js',
  type: 'module',
  bundlePatch: './cordis.patch.yml',
  // 计划 §7.1：最低 DSH 0.2.2-rc.5，上界 <0.3.0。
  dshEngine: ['>=0.2.2-rc.5', '<0.3.0'],
  // 计划 §5 package.json 行：加 ./client、./locale/*.json 导出。
  clientExportKey: './client',
  clientExportTarget: './client.js',
  localeExports: ['locale/en.json', 'locale/zh.json'],
};

// 计划 §7.1 的允许项（npm tarball 内 package/ 之后相对路径）。
const ALLOWED_FILES = [
  'package.json',
  'LICENSE',
  'README.md',
  'README.en.md',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/policy.js',
  'lib/delegation.js',
  'lib/setup.js',
  'lib/team-fit.js',
  'lib/config.js',
  'lib/watchdog.js',
  'client.js',
  'locale/en.json',
  'locale/zh.json',
  'docs/plugin-detail.md',
];
const ALLOWED_SET = new Set(ALLOWED_FILES);
// npm 会无条件收进 tarball 的清单文件，不要求 files 字段显式覆盖。
const NPM_AUTO_FILES = new Set(['package.json', 'README.md', 'README.en.md', 'LICENSE']);

// 安装/打包生命周期脚本：包内一律不得携带（计划 §7.1）。
const FORBIDDEN_SCRIPTS = [
  'preinstall', 'install', 'postinstall',
  'prepare', 'prepack', 'postpack',
  'prepublish', 'prepublishOnly', 'publish', 'postpublish',
];

// 隐私项（内容级）：只报告类别与路径，不打印命中文本。
// 这里只放“通用”判定（本机绝对路径、RFC1918 私网地址、常见凭据形态）；
// 具体私有主机/词条绝不写死进本脚本，需要时由运行环境用逗号分隔传入
// DSH_RELEASE_PRIVATE_PATTERNS（字面词条，只做包含匹配，本变量内容不入库）。
const PRIVACY_CONTENT_PATTERNS = [
  { category: 'local-absolute-path', re: /[A-Za-z]:[\\/]Users[\\/]|\/Users\/[A-Za-z0-9._-]+\/|\/home\/[a-z][a-z0-9._-]*\// },
  { category: 'private-host', re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/ },
  { category: 'credential', re: /\bsk-[A-Za-z0-9]{20,}|\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bnpm_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bBearer\s+[A-Za-z0-9._-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const ENV_PRIVATE_PATTERNS = (process.env.DSH_RELEASE_PRIVATE_PATTERNS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

// 禁止进入已核对 Git 树/待推历史的私有路径（计划 §7.1“私密检查”）。
const FORBIDDEN_TREE_PATHS = [
  /(^|\/)reference\//,
  /(^|\/)docs\/plans\//,
  /(^|\/)tests\/_scratch\//,
  /(^|\/)node_modules\//,
  /(^|\/)__pycache__\//,
  /(^|\/)\.git\//,
  /(^|\/)\.env[^/]*$/,
  /\.pyc$/,
  /\.bak-/,
  /(^|\/)HANDOFF\.md$/,
];

const MAX_TGZ_BYTES = 32 * 1024 * 1024;
const MAX_TAR_BYTES = 128 * 1024 * 1024;

class GateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GateError';
  }
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// 只把公开路径/文件类型写进输出；tarball 内名字是外部输入，先转义再截断。
function safeLabel(value) {
  const text = String(value ?? '');
  let escaped = '';
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code >= 0x20 && code < 0x7f) escaped += char;
    else escaped += '\\u' + code.toString(16).padStart(4, '0');
  }
  return escaped.length > 120 ? escaped.slice(0, 120) + '…' : escaped;
}

function parseOctalField(header, offset, length) {
  let start = offset;
  while (start < offset + length && header[start] === 0x20) start += 1; // 容忍前导空格
  let end = offset + length;
  while (end > start && (header[end - 1] === 0 || header[end - 1] === 0x20)) end -= 1;
  if (end === start) return 0; // 空字段按 0 处理（size 之外的字段可能为空）
  let digits = '';
  for (let i = start; i < end; i += 1) {
    const byte = header[i];
    if (byte >= 0x30 && byte <= 0x37) digits += String.fromCharCode(byte);
    else if (byte === 0 || byte === 0x20) break;
    else throw new GateError('tar 头字段不是合法八进制数字');
  }
  if (!digits) throw new GateError('tar 头字段不是合法八进制数字');
  return Number.parseInt(digits, 8);
}

function isZeroBlock(block) {
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] !== 0) return false;
  }
  return true;
}

/**
 * 严格的 tar 解析：只接受 ustar 普通文件条目。
 * 返回 [{ name, data }]，其中 name 已去掉固定的 "package/" 前缀候选者由调用方校验。
 */
function parseTar(tarBuffer) {
  if (tarBuffer.length === 0) throw new GateError('tar 内容为空');
  if (tarBuffer.length % 512 !== 0) throw new GateError('tar 长度不是 512 字节块的整数倍');
  const entries = [];
  let offset = 0;
  let zeroBlocks = 0;
  let ended = false;
  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    if (isZeroBlock(header)) {
      zeroBlocks += 1;
      offset += 512;
      if (zeroBlocks >= 2 && !ended) {
        ended = true;
        // 结束标记之后只允许零填充。
        for (let i = offset; i < tarBuffer.length; i += 1) {
          if (tarBuffer[i] !== 0) throw new GateError('tar 结束标记之后存在多余数据');
        }
        offset = tarBuffer.length;
        break;
      }
      continue;
    }
    if (ended) throw new GateError('tar 结束标记之后存在额外条目');
    zeroBlocks = 0;

    const expectedChecksum = parseOctalField(header, 148, 8);
    let actualChecksum = 0;
    for (let i = 0; i < 512; i += 1) {
      actualChecksum += i >= 148 && i < 156 ? 0x20 : header[i];
    }
    if (expectedChecksum !== actualChecksum) {
      throw new GateError('tar 头校验和不匹配（文件损坏或被改动）');
    }

    const magic = header.subarray(257, 263).toString('latin1');
    if (!magic.startsWith('ustar')) throw new GateError('tar 头格式不是 ustar');

    const typeFlag = header[156];
    const isRegular = typeFlag === 0x00 || typeFlag === 0x30; // '\0' 或 '0'
    if (!isRegular) {
      const typeName = typeFlag === 0x35 ? '目录'
        : typeFlag === 0x31 ? '硬链接'
          : typeFlag === 0x32 ? '符号链接'
            : typeFlag === 0x78 || typeFlag === 0x67 ? '扩展头'
              : typeFlag === 0x4c || typeFlag === 0x4b ? '长文件名头'
                : `类型 0x${typeFlag.toString(16).padStart(2, '0')}`;
      const name = cString(header, 0, 100);
      throw new GateError(`tarball 含非普通文件条目（${typeName}）：${safeLabel(name)}`);
    }

    let name = cString(header, 0, 100);
    const prefix = cString(header, 345, 155);
    if (prefix) name = prefix + '/' + name;
    const size = parseOctalField(header, 124, 12);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tarBuffer.length) throw new GateError('tar 条目长度越界');
    entries.push({ name, data: tarBuffer.subarray(dataStart, dataEnd) });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!ended) throw new GateError('tar 缺少结束标记（0 块）');
  return entries;
}

function cString(buffer, offset, length) {
  let end = offset;
  while (end < offset + length && buffer[end] !== 0) end += 1;
  return buffer.subarray(offset, end).toString('utf8');
}

function validateEntryName(rawName) {
  const name = String(rawName);
  if (!name.startsWith('package/')) {
    throw new GateError(`tarball 必须只有 package/ 根目录条目：${safeLabel(name)}`);
  }
  const rel = name.slice('package/'.length);
  if (!rel) throw new GateError('tarball 含空条目名');
  if (rel.includes('\\')) throw new GateError(`tarball 条目名含反斜杠：${safeLabel(name)}`);
  if (/^[A-Za-z]:/.test(rel)) throw new GateError(`tarball 条目名是绝对路径：${safeLabel(name)}`);
  if (rel.startsWith('/')) throw new GateError(`tarball 条目名是绝对路径：${safeLabel(name)}`);
  if (!/^[\x20-\x7e]+$/.test(rel)) throw new GateError(`tarball 条目名含不可打印/非 ASCII 字符：${safeLabel(name)}`);
  if (rel.length > 200) throw new GateError('tarball 条目名过长');
  const segments = rel.split('/');
  for (const segment of segments) {
    if (!segment) throw new GateError(`tarball 条目名含空路径段：${safeLabel(name)}`);
    if (segment === '.' || segment === '..') throw new GateError(`tarball 条目名含越界路径段：${safeLabel(name)}`);
  }
  if (path.posix.normalize(rel) !== rel) throw new GateError(`tarball 条目名不是规范路径：${safeLabel(name)}`);
  return rel;
}

function normalizeVersionRange(value) {
  return String(value).trim().replace(/\s+/g, ' ').replace(/(>=|<=|>|<|=)\s+/g, '$1');
}

function rangeTokensSatisfy(value, requiredTokens) {
  const tokens = normalizeVersionRange(value).split(' ').filter(Boolean).sort();
  const required = [...requiredTokens].sort();
  if (tokens.length !== required.length) return false;
  return tokens.every((token, index) => token === required[index]);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function flattenExportTargets(value, out) {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith('.')) continue; // 条件对象里不会出现子路径键；出现即另行报错
      flattenExportTargets(child, out);
    }
    return;
  }
  throw new GateError('exports 条目既不是字符串也不是对象');
}

function matchGlob(patternText, candidate) {
  const escaped = patternText
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp('^' + escaped + '$').test(candidate);
}

// 把 exports 的子路径模式（如 ./locale/*.json）按实际导入路径解析成目标文件。
function resolvePatternTarget(key, target, requested) {
  const starAt = key.indexOf('*');
  if (starAt < 0) return target;
  const prefix = key.slice(0, starAt);
  const suffix = key.slice(starAt + 1);
  if (!requested.startsWith(prefix) || !requested.endsWith(suffix)) return null;
  const captured = requested.slice(prefix.length, requested.length - suffix.length);
  if (!captured || captured.includes('/')) return null;
  return target.replace('*', captured);
}

function checkFilesField(files, errors) {
  if (!Array.isArray(files) || files.length === 0) {
    errors.push({ category: 'manifest', message: 'package.json 缺少非空的 files 分发白名单' });
    return;
  }
  const covered = new Set();
  for (const raw of files) {
    if (typeof raw !== 'string' || !raw.trim()) {
      errors.push({ category: 'manifest', message: 'files 含空或非字符串条目' });
      continue;
    }
    const entry = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!entry || entry.startsWith('/') || entry.split('/').some((segment) => segment === '..' || segment === '.')) {
      errors.push({ category: 'manifest', message: `files 条目不是规范的相对路径：${safeLabel(raw)}` });
      continue;
    }
    const matched = ALLOWED_FILES.filter((candidate) => (
      entry.includes('*') ? matchGlob(entry, candidate) : (candidate === entry || candidate.startsWith(entry + '/'))
    ));
    if (matched.length === 0) {
      errors.push({ category: 'manifest', message: `files 条目会引入白名单外内容：${safeLabel(entry)}` });
      continue;
    }
    for (const candidate of matched) covered.add(candidate);
  }
  const missing = ALLOWED_FILES.filter((candidate) => !covered.has(candidate) && !NPM_AUTO_FILES.has(candidate));
  if (missing.length > 0) {
    errors.push({ category: 'manifest', message: `files 未覆盖应分发文件：${missing.join('、')}` });
  }
}

function checkExports(manifest, errors) {
  const exportsField = manifest.exports;
  if (!isPlainObject(exportsField)) {
    errors.push({ category: 'manifest', message: 'package.json exports 必须是对象' });
    return;
  }
  let leavesById = new Map();
  for (const [key, value] of Object.entries(exportsField)) {
    const leaves = [];
    try {
      flattenExportTargets(value, leaves);
    } catch (error) {
      errors.push({ category: 'manifest', message: `exports["${safeLabel(key)}"] 结构不合法` });
      continue;
    }
    leavesById.set(key, leaves);
  }

  const requireTarget = (key, expectedTarget, label) => {
    const leaves = leavesById.get(key);
    if (!leaves) {
      errors.push({ category: 'manifest', message: `exports 缺少 ${label} 入口 ${key}` });
      return;
    }
    if (!leaves.includes(expectedTarget)) {
      errors.push({ category: 'manifest', message: `exports["${key}"] 应指向 ${expectedTarget}，实际为 ${leaves.map(safeLabel).join('、') || '空'}` });
    }
  };

  requireTarget('.', './' + EXPECTED.main, '主');
  requireTarget('./package.json', './package.json', '清单');
  requireTarget('./cordis.patch.yml', './cordis.patch.yml', '插件补丁');
  requireTarget(EXPECTED.clientExportKey, EXPECTED.clientExportTarget, '浏览器 client');

  // locale 可以用显式键，也可以用 ./locale/*.json 这样的子路径模式。
  for (const localeRel of EXPECTED.localeExports) {
    const expectedTarget = './' + localeRel;
    const direct = leavesById.get(expectedTarget);
    if (direct) {
      if (!direct.includes(expectedTarget)) {
        errors.push({ category: 'manifest', message: `exports["${expectedTarget}"] 应指向 ${expectedTarget}` });
      }
      continue;
    }
    let matchedPattern = false;
    for (const [key, leaves] of leavesById) {
      if (!key.includes('*')) continue;
      if (!matchGlob(key, expectedTarget)) continue;
      matchedPattern = true;
      const resolved = leaves.map((leaf) => resolvePatternTarget(key, leaf, expectedTarget));
      if (!resolved.includes(expectedTarget)) {
        errors.push({ category: 'manifest', message: `exports["${key}"] 应解析到 ${expectedTarget}` });
      }
    }
    if (!matchedPattern) {
      errors.push({ category: 'manifest', message: `exports 缺少 ${expectedTarget} 的导出` });
    }
  }

  // 除 locale 子路径模式外，所有 exports 目标必须落在允许项内；避免导出未分发的文件。
  for (const [key, leaves] of leavesById) {
    for (const leaf of leaves) {
      if (typeof leaf !== 'string') continue;
      if (leaf.includes('*')) {
        if (key !== './locale/*.json' || leaf !== './locale/*.json') {
          errors.push({ category: 'manifest', message: `exports["${key}"] 含未约定的模式目标：${safeLabel(leaf)}` });
        }
        continue;
      }
      if (leaf.startsWith('./')) {
        const rel = leaf.slice(2);
        if (!ALLOWED_SET.has(rel)) {
          errors.push({ category: 'manifest', message: `exports["${key}"] 指向未分发文件：${safeLabel(leaf)}` });
        }
      } else {
        errors.push({ category: 'manifest', message: `exports["${key}"] 目标必须是包内相对路径：${safeLabel(leaf)}` });
      }
    }
  }
}

function verifyManifest(manifest, fileMap, errors) {
  if (!isPlainObject(manifest)) {
    errors.push({ category: 'manifest', message: 'package.json 不是 JSON 对象' });
    return;
  }
  if (manifest.name !== EXPECTED.name) {
    errors.push({ category: 'manifest', message: `包名应为 ${EXPECTED.name}，实际为 ${safeLabel(manifest.name)}` });
  }
  if (manifest.version !== EXPECTED.version) {
    errors.push({ category: 'manifest', message: `候选版本应为 ${EXPECTED.version}，实际为 ${safeLabel(manifest.version)}` });
  }
  if (manifest.main !== EXPECTED.main) {
    errors.push({ category: 'manifest', message: `main 入口应为 ${EXPECTED.main}，实际为 ${safeLabel(manifest.main)}` });
  }
  if (manifest.type !== EXPECTED.type) {
    errors.push({ category: 'manifest', message: `type 应为 ${EXPECTED.type}，实际为 ${safeLabel(manifest.type)}` });
  }
  if (manifest.private === true) {
    errors.push({ category: 'manifest', message: 'package.json 不能是 private 包' });
  }

  const dsh = manifest.dsh;
  if (!isPlainObject(dsh) || !isPlainObject(dsh.bundle) || dsh.bundle.patch !== EXPECTED.bundlePatch) {
    errors.push({ category: 'manifest', message: `dsh.bundle.patch 应为 ${EXPECTED.bundlePatch}` });
  }
  const engines = manifest.engines;
  if (!isPlainObject(engines) || typeof engines.dsh !== 'string' || !rangeTokensSatisfy(engines.dsh, EXPECTED.dshEngine)) {
    errors.push({
      category: 'manifest',
      message: `engines.dsh 应为 "${EXPECTED.dshEngine.join(' ')}"，实际为 ${safeLabel(engines && engines.dsh)}`,
    });
  }

  checkExports(manifest, errors);
  checkFilesField(manifest.files, errors);

  const scripts = isPlainObject(manifest.scripts) ? manifest.scripts : {};
  for (const name of FORBIDDEN_SCRIPTS) {
    if (Object.prototype.hasOwnProperty.call(scripts, name)) {
      errors.push({ category: 'manifest', message: `package.json 不得携带 ${name} 生命周期脚本` });
    }
  }

  for (const field of ['dependencies', 'optionalDependencies', 'bundledDependencies', 'bundleDependencies']) {
    if (!Object.hasOwn(manifest, field)) continue;
    const value = manifest[field];
    if ((isPlainObject(value) && Object.keys(value).length === 0) || (Array.isArray(value) && value.length === 0)) continue;
    errors.push({ category: 'manifest', message: `包不得通过 ${field} 新增运行时依赖` });
  }
  if (!isPlainObject(manifest.peerDependencies) || typeof manifest.peerDependencies['@deepseek-ai/schemastery'] !== 'string') {
    errors.push({ category: 'manifest', message: 'peerDependencies 必须保留 @deepseek-ai/schemastery' });
  }

  // cordis.patch.yml：保持单行 submodel 装载（计划 §5）。
  const patch = fileMap.get('cordis.patch.yml').toString('utf8');
  if (!/(^|\n)\s*-\s*id:\s*submodel\s*$/m.test(patch)) {
    errors.push({ category: 'manifest', path: 'cordis.patch.yml', message: '插件补丁缺少单行 submodel 装载' });
  }
  if (/model-routing/.test(patch)) {
    errors.push({ category: 'manifest', path: 'cordis.patch.yml', message: '插件补丁仍含旧 model-routing 入口' });
  }

  for (const localePath of EXPECTED.localeExports) {
    try {
      const parsed = JSON.parse(fileMap.get(localePath).toString('utf8'));
      if (!isPlainObject(parsed)) throw new Error('not object');
    } catch {
      errors.push({ category: 'manifest', path: localePath, message: '语言文件不是合法的 JSON 对象' });
    }
  }
  if (fileMap.get('client.js').length === 0) {
    errors.push({ category: 'manifest', path: 'client.js', message: '浏览器产物为空' });
  }
  if (fileMap.get(EXPECTED.main).length === 0) {
    errors.push({ category: 'manifest', path: EXPECTED.main, message: '主入口为空' });
  }
}

function verifyPrivacy(fileMap, errors) {
  for (const [relPath, buffer] of fileMap) {
    if (buffer.includes(0)) {
      errors.push({ category: 'privacy', path: relPath, message: '发布文本文件中出现二进制内容' });
      continue;
    }
    const text = buffer.toString('utf8');
    for (const pattern of PRIVACY_CONTENT_PATTERNS) {
      if (pattern.re.test(text)) {
        // 只报告类别与路径：命中的敏感值绝不进入输出。
        errors.push({ category: `privacy:${pattern.category}`, path: relPath, message: '命中隐私项（值不打印，请人工复核）' });
      }
    }
    if (ENV_PRIVATE_PATTERNS.length > 0) {
      const lowerText = text.toLowerCase();
      for (const literal of ENV_PRIVATE_PATTERNS) {
        if (lowerText.includes(literal.toLowerCase())) {
          errors.push({ category: 'privacy:env-private', path: relPath, message: '命中运行环境提供的私有词条（值不打印，请人工复核）' });
          break;
        }
      }
    }
  }
}

function contentSummary(files) {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const lines = sorted.map((file) => `${file.path}\n${file.sha256}\n`).join('');
  return sha256Hex(Buffer.from(lines, 'utf8'));
}

function emit(mode, errors, payload) {
  const { json, ...rest } = payload;
  if (json) {
    process.stdout.write(JSON.stringify({ ok: errors.length === 0, mode, errors, ...rest }) + '\n');
  } else {
    for (const error of errors) {
      const where = error.path ? `${error.path}: ` : '';
      process.stdout.write(`✗ [${error.category}] ${where}${error.message}\n`);
    }
  }
}

function verifyTarball(tgzPath, { json, expectContentSha256 }) {
  const errors = [];
  const absPath = path.resolve(tgzPath);
  if (!fs.existsSync(absPath)) {
    throw new GateError(`找不到候选 tarball：${absPath}`);
  }
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) throw new GateError(`候选路径不是文件：${absPath}`);
  if (stat.size > MAX_TGZ_BYTES) throw new GateError('候选 tarball 体积异常大');
  const tgzBuffer = fs.readFileSync(absPath);
  if (tgzBuffer.length < 2 || tgzBuffer[0] !== 0x1f || tgzBuffer[1] !== 0x8b) {
    throw new GateError('候选文件不是 gzip 压缩的 tar 包');
  }
  let tarBuffer;
  try {
    tarBuffer = zlib.gunzipSync(tgzBuffer, { maxOutputLength: MAX_TAR_BYTES });
  } catch {
    throw new GateError('gzip/tar 解压失败（不是合法 tarball）');
  }

  const entries = parseTar(tarBuffer);
  if (entries.length === 0) throw new GateError('tarball 不含任何文件');

  const seen = new Set();
  const fileMap = new Map();
  const files = [];
  for (const entry of entries) {
    const rel = validateEntryName(entry.name);
    if (seen.has(rel)) throw new GateError(`tarball 含重复条目：${safeLabel(rel)}`);
    seen.add(rel);
    fileMap.set(rel, entry.data);
    files.push({ path: rel, bytes: entry.data.length, sha256: sha256Hex(entry.data) });
  }

  const missing = ALLOWED_FILES.filter((candidate) => !seen.has(candidate));
  const extra = [...seen].filter((candidate) => !ALLOWED_SET.has(candidate));
  if (missing.length > 0) {
    errors.push({ category: 'file-set', message: `缺少允许项文件：${missing.join('、')}` });
  }
  if (extra.length > 0) {
    errors.push({ category: 'file-set', message: `包含白名单外文件：${extra.sort().join('、')}` });
  }

  if (missing.length === 0) {
    // 结构通过后才按内容检查版本、入口、导出与隐私项。
    let manifest = null;
    try {
      manifest = JSON.parse(fileMap.get('package.json').toString('utf8'));
    } catch {
      errors.push({ category: 'manifest', path: 'package.json', message: 'package.json 不是合法 JSON' });
    }
    if (manifest) verifyManifest(manifest, fileMap, errors);
    verifyPrivacy(fileMap, errors);
  }

  const summary = {
    tgz: absPath,
    tarballBytes: tgzBuffer.length,
    tarballSha256: sha256Hex(tgzBuffer),
    fileCount: files.length,
    files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    contentSha256: contentSummary(files),
  };

  if (expectContentSha256) {
    if (summary.contentSha256 !== expectContentSha256.toLowerCase()) {
      errors.push({
        category: 'content-sha256',
        message: `内容摘要不一致：期望 ${expectContentSha256.toLowerCase()}，实际 ${summary.contentSha256}`,
      });
    }
  }

  emit('verify', errors, { ...summary, json });
  if (!json && errors.length === 0) {
    for (const file of summary.files) {
      process.stdout.write(`  ${file.path}  ${file.bytes} 字节  ${file.sha256.slice(0, 12)}…\n`);
    }
    process.stdout.write(`pack-content-sha256: ${summary.contentSha256}\n`);
    process.stdout.write(`tarball-sha256: ${summary.tarballSha256}\n`);
    process.stdout.write(`结果：通过（${summary.fileCount} 个文件）\n`);
  } else if (!json) {
    process.stdout.write(`结果：失败（${errors.length} 项）\n`);
  }
  return errors.length === 0;
}

function git(args, options = {}) {
  try {
    return execFileSync('git', args, { maxBuffer: 32 * 1024 * 1024, ...options });
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString('utf8').trim() : '';
    throw new GateError(`git 命令失败（git ${args.join(' ')}）${stderr ? '：' + stderr : ''}`);
  }
}

function materialize(destDir, rev, { json }) {
  const errors = [];
  const absDest = path.resolve(destDir);
  const repoRoot = git(['rev-parse', '--show-toplevel']).toString('utf8').trim();
  // 支持提交、注解 tag 与零提交的暂存树（计划 §7.1：实施验收样本可来自暂存快照）：
  // 采用 ^{tree} 把任意 tree-ish 收敛成树对象，git write-tree 生成的树可直接传入。
  const resolvedTree = git(['rev-parse', '--verify', `${rev}^{tree}`]).toString('utf8').trim();
  const resolvedType = git(['cat-file', '-t', resolvedTree]).toString('utf8').trim();
  if (resolvedType !== 'tree') {
    throw new GateError(`${rev} 不是可解析为树的 Git 对象（实际类型：${resolvedType}）`);
  }
  // 已核对树的自身不得包含私有/忽略路径（计划 §7.1 私密检查）。
  const treePaths = git(['ls-tree', '-r', '--name-only', resolvedTree]).toString('utf8').split('\n').filter(Boolean);
  const forbiddenTreePaths = treePaths.filter((treePath) => FORBIDDEN_TREE_PATHS.some((pattern) => pattern.test(treePath)));
  for (const treePath of forbiddenTreePaths) {
    errors.push({ category: 'private-path', path: treePath, message: '已核对 Git 树含私有/本机路径，不得进入公开仓' });
  }
  const destInsideRepo = absDest === repoRoot || absDest.startsWith(repoRoot + path.sep);
  if (destInsideRepo) {
    throw new GateError('物化目录必须位于仓库之外（计划要求在隔离目录打包）');
  }
  if (fs.existsSync(absDest)) {
    if (!fs.statSync(absDest).isDirectory()) throw new GateError('物化目标不是目录');
    if (fs.readdirSync(absDest).length > 0) throw new GateError('物化目标目录必须为空，避免混入未核对内容');
  }
  fs.mkdirSync(absDest, { recursive: true });

  const files = [];
  const missing = [];
  for (const relPath of ALLOWED_FILES) {
    let buffer;
    try {
      buffer = git(['cat-file', 'blob', `${resolvedTree}:${relPath}`]);
    } catch {
      missing.push(relPath);
      continue;
    }
    const target = path.join(absDest, ...relPath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buffer);
    // 立即回读校验，确保落盘字节与 Git blob 完全一致（规避 Windows 换行转换）。
    if (!fs.readFileSync(target).equals(buffer)) {
      throw new GateError(`物化回读字节不一致：${relPath}`);
    }
    files.push({ path: relPath, bytes: buffer.length, sha256: sha256Hex(buffer) });
  }
  if (missing.length > 0) {
    errors.push({ category: 'git-tree', message: `已核对树中缺少允许项文件：${missing.join('、')}` });
  }
  const sorted = files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const summary = {
    dest: absDest,
    repoRoot,
    tree: resolvedTree,
    fileCount: files.length,
    files: sorted,
    contentSha256: contentSummary(files),
  };
  emit('materialize', errors, { ...summary, json });
  if (!json && errors.length === 0) {
    process.stdout.write(`pack-content-sha256: ${summary.contentSha256}\n`);
    process.stdout.write(`结果：通过（${summary.fileCount} 个文件，Git 树 ${summary.tree} 的原始 blob 字节）\n`);
  }
  return errors.length === 0;
}

function main() {
  const argv = process.argv.slice(2);
  let mode = 'verify';
  let positional = null;
  let json = false;
  let expectContentSha256 = null;
  let destDir = null;
  let rev = 'HEAD';

  const readValue = (index, flag) => {
    if (index + 1 >= argv.length) throw new GateError(`缺少参数值：${flag}`);
    return argv[index + 1];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { json = true; continue; }
    if (arg === '--materialize') { mode = 'materialize'; destDir = readValue(i, arg); i += 1; continue; }
    if (arg === '--rev') { rev = readValue(i, arg); i += 1; continue; }
    if (arg === '--expect-content-sha256') { expectContentSha256 = readValue(i, arg); i += 1; continue; }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write('用法：node scripts/verify-package.mjs <候选.tgz> [--json] [--expect-content-sha256 <hex>]\n');
      process.stdout.write('      node scripts/verify-package.mjs --materialize <隔离目录> [--rev <提交>] [--json]\n');
      return 0;
    }
    if (arg.startsWith('-')) throw new GateError(`未知参数：${safeLabel(arg)}`);
    if (positional) throw new GateError('只能指定一个候选 tarball 路径');
    positional = arg;
  }

  if (expectContentSha256 && !/^[0-9a-fA-F]{64}$/.test(expectContentSha256)) {
    throw new GateError('--expect-content-sha256 必须是 64 位十六进制字符串');
  }
  if (mode === 'materialize') {
    if (!destDir) throw new GateError('--materialize 缺少目标目录');
    if (positional) throw new GateError('--materialize 模式不接受候选 tarball 参数');
    return materialize(destDir, rev, { json }) ? 0 : 1;
  }
  if (!positional) throw new GateError('缺少候选 tarball 路径（或用 --materialize 生成打包输入）');
  return verifyTarball(positional, { json, expectContentSha256 }) ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  if (error instanceof GateError) {
    process.stderr.write(`✗ 校验失败：${error.message}\n`);
  } else {
    process.stderr.write(`✗ 校验异常：${error && error.message ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
}
