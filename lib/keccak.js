// Keccak-256 (variante de Ethereum, padding 0x01) con BigInt.
const RC = ['0x0000000000000001','0x0000000000008082','0x800000000000808a','0x8000000080008000','0x000000000000808b','0x0000000080000001','0x8000000080008081','0x8000000000008009','0x000000000000008a','0x0000000000000088','0x0000000080008009','0x000000008000000a','0x000000008000808b','0x800000000000008b','0x8000000000008089','0x8000000000008003','0x8000000000008002','0x8000000000000080','0x000000000000800a','0x800000008000000a','0x8000000080008081','0x8000000000008080','0x0000000080000001','0x8000000080008008'].map(BigInt);
const ROT = [[0,36,3,41,18],[1,44,10,45,2],[62,6,43,15,61],[28,55,25,21,56],[27,20,39,8,14]];
const M = (1n << 64n) - 1n;
const rotl = (x, n) => n === 0 ? x : (((x << BigInt(n)) | (x >> BigInt(64 - n))) & M);
function f(A) {
  for (let r = 0; r < 24; r++) {
    const C = [0,1,2,3,4].map(x => A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4]);
    const D = [0,1,2,3,4].map(x => C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1));
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] ^= D[x];
    const B = [[],[],[],[],[]];
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y][(2 * x + 3 * y) % 5] = rotl(A[x][y], ROT[x][y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] = B[x][y] ^ ((~B[(x + 1) % 5][y] & M) & B[(x + 2) % 5][y]);
    A[0][0] ^= RC[r];
  }
}
function keccak256(input) {
  const rate = 136;
  const msg = Buffer.concat([Buffer.from(input), Buffer.alloc(rate - (input.length % rate))]);
  msg[input.length] ^= 0x01; msg[msg.length - 1] ^= 0x80;
  const A = [0,1,2,3,4].map(() => [0n,0n,0n,0n,0n]);
  for (let off = 0; off < msg.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      const x = i % 5, y = Math.floor(i / 5);
      A[x][y] ^= msg.readBigUInt64LE(off + i * 8);
    }
    f(A);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(A[i % 5][Math.floor(i / 5)], i * 8);
  return out;
}
module.exports = { keccak256 };
