import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('uses committed per-order payout figures in the LINE settlement summary', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(
    source,
    /คืนเงินเดิมพันตัวเอง 100 \+ 90% จากคู่แข่ง 90 = รับรวม 190 แต้ม; บ้านรับ 10 แต้มจากผู้แพ้/,
  );
  assert.match(source, /formatSettlementPayoutText\(o\)/);
  assert.match(source, /ถ้าเสมอ: คืนเงินเดิมพันของทั้งสองฝ่ายเต็มจำนวน ไม่มีค่าธรรมเนียม/);
});
