// Optional execution evidence, never a health verdict. Only overwrite a caller-owned nonce file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export function sessionStartProofRecorder({ env, sourcePath, cwd, version }) {
  const file = env.RUVNET_BRAIN_HOST_PROOF_PATH;
  const nonce = env.RUVNET_BRAIN_HOST_PROOF_NONCE;
  if (!file && !nonce) return () => false;
  let fd;
  try {
    if (process.platform === 'win32' || !path.isAbsolute(file || '') || !/^[a-f0-9]{64}$/.test(nonce || '')) return () => false;
    const parent = path.dirname(file); const dir = fs.lstatSync(parent);
    if (!dir.isDirectory() || dir.isSymbolicLink() || fs.realpathSync(parent) !== parent
      || dir.uid !== process.getuid() || (dir.mode & 0o777) !== 0o700) return () => false;
    fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > 1024) throw new Error('Unsafe proof file');
    const seed = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (seed.schema !== 1 || seed.state !== 'pending' || seed.nonce !== nonce || Object.keys(seed).length !== 3) throw new Error('Proof seed mismatch');
    const sourceSha256 = digest(fs.readFileSync(sourcePath)); const startedAt = Date.now();
    fs.closeSync(fd); fd = undefined;
    return ({ stages, restore, bodyFailed, bannerFallback }) => {
      let receiptFd;
      try {
        const current = fs.lstatSync(file);
        const parentNow = fs.lstatSync(parent);
        if (current.ino !== stat.ino || current.dev !== stat.dev || current.isSymbolicLink()
          || current.uid !== stat.uid || (current.mode & 0o777) !== 0o600 || current.nlink !== 1
          || parentNow.uid !== dir.uid || parentNow.ino !== dir.ino || parentNow.dev !== dir.dev || (parentNow.mode & 0o777) !== 0o700
          || fs.realpathSync(parent) !== parent || digest(fs.readFileSync(sourcePath)) !== sourceSha256) return false;
        receiptFd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(receiptFd);
        if (opened.ino !== stat.ino || opened.dev !== stat.dev) return false;
        if (opened.size > 1024 || JSON.stringify(JSON.parse(fs.readFileSync(receiptFd, 'utf8'))) !== JSON.stringify(seed)) return false;
        const receipt = { schema: 1, state: 'body-executed', nonce, pid: process.pid,
          sourcePath, sourceSha256, cwd, version, startedAt, finishedAt: Date.now(),
          restore, stages, bodyFailed, bannerFallback, scope: 'stage-return-milestones',
          health: 'unknown', detachedMaintenance: 'possible' };
        const bytes = `${JSON.stringify(receipt)}\n`;
        fs.writeSync(receiptFd, bytes, 0, 'utf8');
        fs.ftruncateSync(receiptFd, Buffer.byteLength(bytes));
        fs.fsyncSync(receiptFd); return true;
      } catch { return false; }
      finally { if (receiptFd !== undefined) fs.closeSync(receiptFd); }
    };
  } catch { if (fd !== undefined) fs.closeSync(fd); return () => false; }
}
