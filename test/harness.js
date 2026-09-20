'use strict';

/** 极简断言器：无依赖、输出可读、失败不退栈。 */

function createHarness(title) {
  let pass = 0;
  let fail = 0;
  const failures = [];

  console.log('');
  console.log('  ' + title);
  console.log('  ' + '-'.repeat(52));

  return {
    section: function (name) {
      console.log('');
      console.log('  [' + name + ']');
    },
    check: function (name, condition, detail) {
      if (condition) {
        pass++;
        console.log('    PASS  ' + name);
      } else {
        fail++;
        failures.push(name + (detail ? '  → ' + detail : ''));
        console.log('    FAIL  ' + name + (detail ? '  → ' + detail : ''));
      }
    },
    summary: function () {
      console.log('');
      console.log('  ' + '-'.repeat(52));
      console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
      if (failures.length) {
        console.log('');
        console.log('  失败明细：');
        failures.forEach(function (f) { console.log('    - ' + f); });
      }
      console.log('');
      return fail;
    }
  };
}

module.exports = { createHarness: createHarness };
