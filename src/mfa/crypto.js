'use strict';
const crypto = require('node:crypto');
// RFC 6238, SHA-1, 6 digits, 30-second periods; compatible with common authenticator apps.
const ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function encodeBase32(buffer){let value=0,bits=0,out='';for(const byte of buffer){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=ALPHABET[(value>>>(bits-=5))&31];}}if(bits)out+=ALPHABET[(value<<(5-bits))&31];return out;}
function decodeBase32(str){if(typeof str!=='string'||!/^[A-Z2-7]{16,64}$/.test(str))throw Error('Invalid TOTP secret');let value=0,bits=0,bytes=[];for(const letter of str){value=(value<<5)|ALPHABET.indexOf(letter);bits+=5;if(bits>=8){bytes.push((value>>>(bits-=8))&255);}}return Buffer.from(bytes);}
function newSecret(){return encodeBase32(crypto.randomBytes(20));}
function totp(secret,step=Math.floor(Date.now()/30000)){
 const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(step));const digest=crypto.createHmac('sha1',decodeBase32(secret)).update(counter).digest();const offset=digest[digest.length-1]&15;const val=(digest.readUInt32BE(offset)&0x7fffffff)%1e6;return String(val).padStart(6,'0');
}
function matchTotp(secret,code,now=Date.now()){
 if(typeof code!=='string'||!/^[0-9]{6}$/.test(code))return null;
 const step=Math.floor(now/30000);for(let delta=-1;delta<=1;delta++){const candidate=totp(secret,step+delta);if(crypto.timingSafeEqual(Buffer.from(candidate),Buffer.from(code)))return step+delta;}return null;
}
function encryptionKey(){const raw=process.env.MFA_ENCRYPTION_KEY;if(typeof raw!=='string'||!/^[a-fA-F0-9]{64}$/.test(raw))throw Error('MFA_ENCRYPTION_KEY must be a persistent 64-digit hexadecimal secret in .env');return Buffer.from(raw,'hex');}
function encryptSecret(secret){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',encryptionKey(),iv);const ciphertext=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);return `v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ciphertext.toString('hex')}`;}
function decryptSecret(encoded){const [version,iv,tag,ciphertext,extra]=String(encoded||'').split(':');if(version!=='v1'||extra!==undefined||!/^[a-f0-9]{24}$/.test(iv||'')||!/^[a-f0-9]{32}$/.test(tag||'')||!/^[a-f0-9]+$/.test(ciphertext||''))throw Error('Invalid encrypted MFA secret');const decipher=crypto.createDecipheriv('aes-256-gcm',encryptionKey(),Buffer.from(iv,'hex'));decipher.setAuthTag(Buffer.from(tag,'hex'));return Buffer.concat([decipher.update(Buffer.from(ciphertext,'hex')),decipher.final()]).toString('utf8');}
function recoveryCodes(){return Array.from({length:8},()=>crypto.randomBytes(16).toString('hex').toUpperCase());}
function normalizedRecovery(input){if(typeof input!=='string')return null;const code=input.replace(/[\s-]/g,'').toUpperCase();return /^[A-F0-9]{32}$/.test(code)?code:null;}
function hashRecovery(userId,code){return crypto.createHash('sha256').update(`sdc-recovery-v1:${userId}:${code}`).digest('hex');}
function otpauthUri(secret,email){return `otpauth://totp/${encodeURIComponent('Smart Dental Clinic:'+email)}?secret=${secret}&issuer=${encodeURIComponent('Smart Dental Clinic')}&algorithm=SHA1&digits=6&period=30`;}
module.exports={newSecret,totp,matchTotp,encryptSecret,decryptSecret,recoveryCodes,normalizedRecovery,hashRecovery,otpauthUri};
