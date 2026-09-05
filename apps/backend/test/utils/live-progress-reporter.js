/**
 * Minimal Jest reporter that streams each test result the moment it finishes.
 * Jest's default reporter buffers a whole test file and only prints when the
 * file completes — for the 4-minute live suite that looks like a hang. This
 * reporter hooks `onTestCaseResult` (called per test, live) so you see progress.
 */
class LiveProgressReporter {
  onTestCaseResult(_test, result) {
    const icon =
      result.status === 'passed' ? '✓' : result.status === 'failed' ? '✗' : '○';
    const ms = result.duration != null ? ` (${result.duration} ms)` : '';
    process.stdout.write(`  ${icon} ${result.fullName}${ms}\n`);
  }
}

module.exports = LiveProgressReporter;
