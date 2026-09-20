'use strict';

/**
 * 命令行公用的参数解析与路径定位。
 *
 * 1.0.x 里两个 bin 都拿 path.join(__dirname, '..') 当基准目录，于是配置、数据、
 * 二维码输出全落在 node_modules/oss-shortlink/ 里面：用户自己的 config.json 和
 * data/links.json 根本读不到，而且 npm 一重装就被覆盖，还在 node_modules 里留下垃圾。
 *
 * 这里统一改成以「用户当前工作目录」为基准，并允许 --config / --data 显式覆盖。
 */

const path = require('path');

function UsageError(message) {
  const e = new Error(message);
  e.name = 'UsageError';
  return e;
}

/**
 * 极简参数解析。
 *   --key value / --key=value / 位置参数
 * 未知的 -* 参数直接报错，不再静默忽略（打错一个字母就默默跑错行为是最难查的 bug）。
 */
function parseArgs(argv, spec) {
  const values = spec.values || [];
  const bools = spec.bools || [];
  const out = { rest: [] };

  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];

    if (a === '--') { out.rest = out.rest.concat(argv.slice(i + 1)); break; }

    let inline = null;
    if (a.slice(0, 2) === '--') {
      const eq = a.indexOf('=');
      if (eq > 2) { inline = a.slice(eq + 1); a = a.slice(0, eq); }
    }

    if (values.indexOf(a) >= 0) {
      let v = inline;
      if (v === null) {
        v = argv[++i];
        if (v === undefined) throw UsageError('参数 ' + a + ' 缺少取值');
      }
      out[a.replace(/^--?/, '')] = v;
      continue;
    }

    if (bools.indexOf(a) >= 0) { out[a.replace(/^--?/, '')] = true; continue; }

    if (a.charAt(0) === '-' && a !== '-') throw UsageError('未知参数：' + a);
    out.rest.push(a);
  }

  return out;
}

/**
 * 解析出配置文件与数据文件的位置。
 * 优先级：命令行 > 环境变量 > 当前工作目录下的 config.json。
 * 数据文件默认和配置文件同目录的 data/links.json，与其他子命令保持一致。
 */
function resolveProject(argv, env) {
  const cwd = process.cwd();
  const configFile = path.resolve(cwd, argv.config || env.CONFIG_FILE || 'config.json');
  const dataArg = argv.data || env.DATA_FILE;
  const dataFile = dataArg
    ? path.resolve(cwd, dataArg)
    : path.join(path.dirname(configFile), 'data', 'links.json');

  return { cwd: cwd, configFile: configFile, dataFile: dataFile };
}

module.exports = {
  UsageError: UsageError,
  parseArgs: parseArgs,
  resolveProject: resolveProject
};
