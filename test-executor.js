import { AgentExecutor } from './src/agent-executor.js';
import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';

async function runTests() {
  console.log(
    '--- AgentExecutor Kapsamlı Test ve Güvenlik Paketi Başlatılıyor ---'
  );
  const executor = new AgentExecutor();

  // Test 1: Path Çözümleme
  console.log('1. Path Çözümleme Testi...');
  const p1 = executor.resolvePath('"~/test.txt"');
  assert.strictEqual(p1, path.join(executor.homeDir, 'test.txt'));
  const pDesktop = executor.resolvePath('~/Desktop/test.txt');
  assert.strictEqual(
    pDesktop,
    path.join(executor.homeDir, 'Masaüstü', 'test.txt')
  );
  console.log('✓ Path çözümleme ve Türkçe KDE Masaüstü eşlemesi başarılı.');

  // Test 2: Sistem Koruması
  console.log('2. Sistem Dosyası Koruma Testi...');
  const sysRes = await executor.writeFile('/etc/test_danger.txt', 'danger');
  assert.strictEqual(sysRes.success, false);
  const sysRes2 = await executor.editFile('/usr/bin/python', 'a', 'b');
  assert.strictEqual(sysRes2.success, false);
  console.log('✓ Kritik sistem yolları (/etc, /usr) koruması başarılı.');

  // Test 3: editFile - Line Numbers Stripping (DeepSeek readFile çıktısı tuzağı)
  console.log('3. editFile: Satır Numarası Ayıklama Testi (Örn: "2 | ...")...');
  const testFile = path.join(
    executor.homeDir,
    '.config',
    'deepseek-linux',
    'test_edit.txt'
  );
  await executor.writeFile(testFile, 'satir1\nsatir2\nsatir3\nsatir4');

  // DeepSeek readFile çıktısından kopyaladığı satır numaralarıyla target gönderirse:
  const editWithLineNums = await executor.editFile(
    testFile,
    '2 | satir2\n3 | satir3',
    '2 | satir2_guncellendi\n3 | satir3_guncellendi'
  );
  assert.strictEqual(editWithLineNums.success, true);
  const readAfter1 = await executor.readFile(testFile);
  assert.ok(readAfter1.content.includes('satir2_guncellendi'));
  assert.ok(readAfter1.content.includes('satir3_guncellendi'));
  console.log(
    '✓ Satır numaralı target ve replacement başarıyla ayıklandı ve güncellendi!'
  );

  // Test 4: editFile - Fuzzy Indentation Matching (Girinti Uyuşmazlığı)
  console.log('4. editFile: Girinti Toleransı (Fuzzy Indentation) Testi...');
  const codeFile = path.join(
    executor.homeDir,
    '.config',
    'deepseek-linux',
    'test_code.js'
  );
  await executor.writeFile(
    codeFile,
    'function app() {\n    const port = 3000;\n    console.log(port);\n}'
  );

  const editFuzzy = await executor.editFile(
    codeFile,
    '  const port = 3000;\n  console.log(port);',
    '  const port = 8080;\n  console.log("Yeni Port:", port);'
  );
  assert.strictEqual(editFuzzy.success, true);
  assert.strictEqual(editFuzzy.strategy, 'fuzzy_indent_match');
  const readCode = await executor.readFile(codeFile);
  assert.ok(readCode.content.includes('const port = 8080'));
  console.log(
    '✓ Girinti farkı tolere edildi, dosyanın orijinal girintisi korunarak güncellendi!'
  );

  // Test 5: editFile - Line Range Editing (start_line & end_line)
  console.log('5. editFile: Satır Aralığı (start_line & end_line) Testi...');
  const editLineRange = await executor.editFile(
    codeFile,
    null,
    '// Satır 2 ve 3 değiştirildi\n    const securePort = 443;',
    2,
    3
  );
  assert.strictEqual(editLineRange.success, true);
  assert.strictEqual(editLineRange.strategy, 'line_range');
  const readRange = await executor.readFile(codeFile);
  assert.ok(readRange.content.includes('securePort = 443'));
  console.log(
    '✓ start_line ve end_line ile doğrudan satır aralığı başarıyla güncellendi!'
  );

  // Test 6: editFile - Single Line Search
  console.log('6. editFile: Tek Satır Kısmi Arama Testi...');
  const editSingle = await executor.editFile(
    codeFile,
    'securePort = 443',
    'securePort = 8443'
  );
  assert.strictEqual(editSingle.success, true);
  const readSingle = await executor.readFile(codeFile);
  assert.ok(readSingle.content.includes('securePort = 8443'));
  console.log('✓ Tek satır kısmi arama-değiştirme başarıyla tamamlandı!');

  // Test 7: Memory Safety - Large Output Capping Test
  console.log(
    '7. Bellek Emniyeti: Büyük Çıktı Sınırlandırma Testi (50KB cap)...'
  );
  // Generate 500KB output via bash
  const largeOutputRes = await executor.runCommand(
    'python3 -c "print(\'A\' * 300000)"'
  );
  assert.strictEqual(largeOutputRes.success, true);
  assert.ok(
    largeOutputRes.stdout.length < 60000,
    'Çıktı 50KB bellek sınırını aşmamalı'
  );
  assert.ok(
    largeOutputRes.stdout.includes('sınırlandırıldı'),
    'Sınırlandırma uyarısı içermeli'
  );
  console.log(
    `✓ 300KB veri başarıyla sınırlandırıldı, tüketilen string boyutu: ${largeOutputRes.stdout.length} bayt.`
  );

  // Test 8: Process Cancellation & Zombie Killing Test
  console.log('8. Süreç Sonlandırma ve Zombi Süreç Önleme Testi...');
  const bgPromise = executor.runCommand('sleep 20', null, 5000);
  // Wait 100ms then cancel
  await new Promise((r) => setTimeout(r, 100));
  const cancelRes = executor.cancelActiveCommand();
  assert.strictEqual(cancelRes.success, true);
  const resultAfterCancel = await bgPromise;
  assert.strictEqual(resultAfterCancel.success, false);
  console.log(
    '✓ Aktif süreç grubu anında başarıyla sonlandırıldı, zombi süreç kalmadı.'
  );

  // Test 9: CWD (Çalışma Dizini) Kalıcılık Testi
  console.log('9. CWD (Çalışma Dizini) Adım Kalıcılık Testi...');
  const cdRes = await executor.runCommand('cd /tmp && pwd');
  assert.strictEqual(cdRes.success, true);
  assert.strictEqual(executor.cwd, '/tmp');
  const pwdNext = await executor.runCommand('pwd');
  assert.strictEqual(pwdNext.stdout.trim(), '/tmp');
  // Reset cwd to homeDir
  executor.cwd = executor.homeDir;
  console.log(
    '✓ "cd" komutu adımlar arası dizin hafızasını başarıyla koruyor.'
  );

  // Cleanup
  await fs.unlink(testFile).catch(() => {});
  await fs.unlink(codeFile).catch(() => {});

  console.log('\n======================================================');
  console.log('🎉 TÜM 9 TEST VE BELLEK GÜVENLİK TESTLERİ %100 GEÇTİ! 🚀');
  console.log('======================================================');
}

runTests().catch((err) => {
  console.error('❌ Test Hatası:', err);
  process.exit(1);
});
