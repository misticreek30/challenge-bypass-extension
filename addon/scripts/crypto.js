/**
 * This implements a 2HashDH-based token scheme using the SJCL ecc package.
 *
 * @author: George Tankersley
 * @author: Alex Davidson
 */

/*global sjcl*/
/* exported checkRequestBinding */
/* exported compressPoint */
/* exported decodeStorablePoint */
/* exported deriveKey */
/* exported encodeStorablePoint */
/* exported sec1DecodePoint */
/* exported newRandomPoint */
/* exported blindPoint, unblindPoint */
/* exported verifyProof */
/* exported getBigNumFromBytes */
/* exported setActiveCommitments */
/* exported ACTIVE_CONFIG */
"use strict";

var p256 = sjcl.ecc.curves.c256;
const BATCH_PROOF_PREFIX = "batch-proof=";
const UNCOMPRESSED_POINT_PREFIX = "04";
const MASK = ["0xff", "0x1", "0x3", "0x7", "0xf", "0x1f", "0x3f", "0x7f"];

const DIGEST_INEQUALITY_ERR = "[privacy-pass]: Recomputed digest does not equal received digest";
const PARSE_ERR = "[privacy-pass]: Error parsing proof";

const COMMITMENT_URL = "https://raw.githubusercontent.com/privacypass/ec-commitments/master/commitments-p256.json";
let ACTIVE_CONFIG = PPConfigs[0];
let activeG, activeH;

// Performs the scalar multiplication k*P
//
// Inputs:
//  k: bigInt scalar (not field element or bits!)
//  P: sjcl Point
// Returns:
//  sjcl Point
function _scalarMult(k, P) {
    const Q = P.mult(k);
    return Q;
}

// blindPoint generates a random scalar blinding factor, multiplies the
// supplied point by it, and returns both values.
function blindPoint(P) {
    const bF = sjcl.bn.random(p256.r, 10);
    const bP = _scalarMult(bF, P);
    return { point: bP, blind: bF };
}

// unblindPoint takes an assumed-to-be blinded point Q and an accompanying
// blinding scalar b, then returns the point (1/b)*Q.
//
// inputs:
//  b: bigint scalar (not field element or bits!)
//  q: sjcl point
// returns:
//  sjcl point
function unblindPoint(b, Q) {
    const binv = b.inverseMod(p256.r);
    return _scalarMult(binv, Q);
}

// Derives the shared key used for redemption MACs
//
// Inputs:
//  N: sjcl Point
//  token: bytes
// Returns:
//  bytes
function deriveKey(N, token) {
    // the exact bits of the string "hash_derive_key"
    const tagBits = sjcl.codec.hex.toBits("686173685f6465726976655f6b6579");
    const h = new sjcl.misc.hmac(tagBits, sjcl.hash.sha256);

    const encodedPoint = sec1EncodePoint(N);
    const tokenBits = sjcl.codec.bytes.toBits(token);
    const pointBits = sjcl.codec.bytes.toBits(encodedPoint);

    h.update(tokenBits);
    h.update(pointBits);

    const keyBytes = sjcl.codec.bytes.fromBits(h.digest());
    return keyBytes;
}

// Generates the HMAC used to bind request data to a particular token redemption.
//
// Inputs:
//  key: raw key bytes as returned by deriveKey
//  data: array of data as bytes
// Returns:
//  bytes
function createRequestBinding(key, data) {
    // the exact bits of the string "hash_request_binding"
    const tagBits = sjcl.codec.utf8String.toBits("hash_request_binding");
    const keyBits = sjcl.codec.bytes.toBits(key);

    const h = new sjcl.misc.hmac(keyBits, sjcl.hash.sha256);
    h.update(tagBits);

    let dataBits = null;
    for (var i = 0; i < data.length; i++) {
        dataBits = sjcl.codec.bytes.toBits(data[i]);
        h.update(dataBits);
    }

    const digestBytes = sjcl.codec.bytes.fromBits(h.digest());
    return digestBytes;
}

// Checks an HMAC generated by createRequestBinding
//
// Inputs:
//  key: key bytes as returned by deriveKey
//  data: data bytes
//  mac: bytes of the MAC to check
// Returns:
//  true if valid, false otherwise
function checkRequestBinding(key, data, mac) {
    const macBits = sjcl.codec.bytes.toBits(mac);
    const observedMAC = createRequestBinding(key, data);
    const observedBits = sjcl.codec.bytes.toBits(observedMAC);

    return sjcl.bitArray.equal(macBits, observedBits);
}

// Creates a new random point on the curve by sampling random bytes and then
// hashing to the chosen curve.
function newRandomPoint() {
    const byteLength = 32;
    const wordLength = byteLength / 4; // SJCL 4 bytes to a word

    // TODO Use webcrypto instead. This is JavaScript Fortuna from 2010.
    var random = sjcl.random.randomWords(wordLength, 10); // paranoia 10
    var point = hashToCurve(random);
    let t;
    if (point) {
        t = { token: sjcl.codec.bytes.fromBits(random), point: point};
    }
    return t;
}

// input: bits
// output: point
function hashToCurve(seed) {
    const h = new sjcl.hash.sha256();

    // Need to match the Go curve hash, so we decode the exact bytes of the
    // string "1.2.840.100045.3.1.7 point generation seed" instead of relying
    // on the utf8 codec that didn't match.
    const separator = sjcl.codec.hex.toBits("312e322e3834302e31303034352e332e312e3720706f696e742067656e65726174696f6e2073656564");

    h.update(separator);

    let i = 0;
    for (i = 0; i < 10; i++) {
        // little endian uint32
        let ctr = new Uint8Array(4);
        // typecast hack: number -> Uint32, bitwise Uint8
        ctr[0] = (i >>> 0) & 0xFF;
        let ctrBits = sjcl.codec.bytes.toBits(ctr);

        // H(s||ctr)
        h.update(seed);
        h.update(ctrBits);

        const digestBits = h.finalize();

        let point = decompressPoint(digestBits, 0x02);
        if (point !== null) {
            return point;
        }

        point = decompressPoint(digestBits, 0x03);
        if (point !== null) {
            return point;
        }

        seed = digestBits;
        h.reset();
    }

    return null;
}

// Attempts to decompress the bytes into a curve point following SEC1 and
// assuming it's a Weierstrass curve with a = -3 and p = 3 mod 4 (true for the
// main three NIST curves).
// input: bits of an x coordinate, the even/odd tag
// output: point
function decompressPoint(xbits, tag) {
    const x = p256.field.fromBits(xbits).normalize();
    const sign = tag & 1;

    // y^2 = x^3 - 3x + b (mod p)
    let rh = x.power(3);
    let threeTimesX = x.mul(3);
    rh = rh.sub(threeTimesX).add(p256.b).mod(p256.field.modulus); // mod() normalizes

    // modsqrt(z) for p = 3 mod 4 is z^(p+1/4)
    const sqrt = p256.field.modulus.add(1).normalize().halveM().halveM();
    let y = rh.powermod(sqrt, p256.field.modulus);

    let parity = y.limbs[0] & 1;

    if (parity != sign) {
        y = p256.field.modulus.sub(y).normalize();
    }

    let point = new sjcl.ecc.point(p256, x, y);
    if (!point.isValid()) {
        return null;
    }
    return point;
}

// Compresses a point according to SEC1.
// input: point
// output: base64-encoded bytes
function compressPoint(p) {
    const xBytes = sjcl.codec.bytes.fromBits(p.x.toBits());
    const sign = p.y.limbs[0] & 1 ? 0x03 : 0x02;
    const taggedBytes = [sign].concat(xBytes);
    return sjcl.codec.base64.fromBits(sjcl.codec.bytes.toBits(taggedBytes));
}

// This has to match Go's elliptic.Marshal, which follows SEC1 2.3.3 for
// uncompressed points.  SJCL's native point encoding is a concatenation of the
// x and y coordinates, so it's *almost* SEC1 but lacks the tag for
// uncompressed point encoding.
//
// Inputs:
//  P: sjcl Point
// Returns:
//  bytes
function sec1EncodePoint(P) {
    const pointBits = P.toBits();
    const xyBytes = sjcl.codec.bytes.fromBits(pointBits);
    return [0x04].concat(xyBytes);
}

// input: base64-encoded bytes
// output: point
function sec1DecodePoint(p) {
    const sec1Bits = sjcl.codec.base64.toBits(p);
    const sec1Bytes = sjcl.codec.bytes.fromBits(sec1Bits);
    return sec1DecodePointFromBytes(sec1Bytes);
}

// Decode point when it is in byte format rather than base64
function sec1DecodePointFromBytes(sec1Bytes) {
    if (sec1Bytes[0] != 0x04) {
        throw new Error("[privacy-pass]: attempted sec1 point decoding with incorrect tag: " + sec1Bytes);
    }
    const coordinates = sec1Bytes.slice(1); // remove "uncompressed" tag
    const pointBits = sjcl.codec.bytes.toBits(coordinates);
    return p256.fromBits(pointBits);
}

// Marshals a point in an SJCL-internal format that can be used with
// JSON.stringify for localStorage.
//
// input: point
// output: base64 string
function encodeStorablePoint(p) {
    const bits = p.toBits();
    return sjcl.codec.base64.fromBits(bits);
}

// Renders a point from SJCL-internal base64.
//
// input: base64 string
// ouput: point
function decodeStorablePoint(s) {
    const bits = sjcl.codec.base64.toBits(s);
    return p256.fromBits(bits);
}


/**
 * DLEQ proof verification logic
 */

// Verifies the DLEQ proof that is returned when tokens are signed
//
// input: marshaled JSON DLEQ proof
// output: bool
function verifyProof(proofObj, tokens, signatures) {
    let bp = getMarshaledBatchProof(proofObj);
    const dleq = retrieveProof(bp);
    if (!dleq) {
        // Error has probably occurred
        return false;
    }
    const chkM = tokens;
    const chkZ = signatures;
    if (chkM.length !== chkZ.length) {
        return false;
    }
    const pointG = sec1DecodePoint(activeG);
    const pointH = sec1DecodePoint(activeH);

    // Recompute A and B for proof verification
    let cH = _scalarMult(dleq.C, pointH);
    let rG = _scalarMult(dleq.R, pointG);
    const A = cH.toJac().add(rG).toAffine();

    let composites = recomputeComposites(chkM, chkZ);
    let cZ = _scalarMult(dleq.C, composites.Z);
    let rM = _scalarMult(dleq.R, composites.M);
    const B = cZ.toJac().add(rM).toAffine();

    // Recalculate C' and check if C =?= C'
    let h = new sjcl.hash.sha256();
    h.update(sjcl.codec.bytes.toBits(sec1EncodePoint(pointG)));
    h.update(sjcl.codec.bytes.toBits(sec1EncodePoint(pointH)));
    h.update(sjcl.codec.bytes.toBits(sec1EncodePoint(composites.M)));
    h.update(sjcl.codec.bytes.toBits(sec1EncodePoint(composites.Z)));
    h.update(sjcl.codec.bytes.toBits(sec1EncodePoint(A)));
    h.update(sjcl.codec.bytes.toBits(sec1EncodePoint(B)));
    const digestBits = h.finalize();
    const receivedDigestBits = dleq.C.toBits();
    if (!sjcl.bitArray.equal(digestBits, receivedDigestBits)) {
        console.error(DIGEST_INEQUALITY_ERR);
        console.error("Computed digest: " + digestBits.toString());
        console.error("Received digest: " + receivedDigestBits.toString());
        return false;
    }
    return true;
}

// Recompute the composite M and Z values for verifying DLEQ
function recomputeComposites(chkM, chkZ) {
    let seed = getSeedPRNG(chkM, chkZ);
    let shake = createShake256();
    shake.update(seed, "hex");
    let cM;
    let cZ;
    for (let i=0; i<chkM.length; i++) {
        let ci = getShakeScalar(shake);
        let cMi = _scalarMult(ci, chkM[i].point);
        let cZi = _scalarMult(ci, chkZ[i]);
        if (cM === undefined || cZ === undefined) {
            cM = cMi;
            cZ = cZi;
        } else {
            cM = cM.toJac().add(cMi).toAffine();
            cZ = cZ.toJac().add(cZi).toAffine();
        }
    }

    return {M: cM, Z: cZ};
}

// Squeeze a seeded shake for output
function getShakeScalar(shake) {
    const curveOrder = p256.r;
    const bitLen = sjcl.bitArray.bitLength(curveOrder.toBits());
    const mask = MASK[bitLen % 8];
    let rnd;

    while(!rnd) {
        let out = shake.squeeze(32, "hex");
        // Masking is not strictly necessary for p256 but better to be completely
        // compatible in case that the curve changes
        let h = "0x" + out.substr(0,2);
        let mh = sjcl.codec.hex.fromBits(sjcl.codec.bytes.toBits([h & mask]));
        out = mh + out.substr(2);
        let nOut = getBigNumFromHex(out);
        // Reject samples outside of correct range
        if (nOut.greaterEquals(curveOrder)) {
            continue;
        }
        rnd = nOut;
    }
    return rnd
}

function getSeedPRNG(chkM, chkZ) {
    let sha256 = new sjcl.hash.sha256();
    sha256.update(encodePointForPRNG(sec1DecodePoint(activeG)));
    sha256.update(encodePointForPRNG(sec1DecodePoint(activeH)));
    for (let i=0; i<chkM.length; i++) {
        sha256.update(encodePointForPRNG(chkM[i].point));
        sha256.update(encodePointForPRNG(chkZ[i]));
    }
    return sjcl.codec.hex.fromBits(sha256.finalize());
}

// Returns a decoded batch proof as a map
function retrieveProof(bp) {
    let dleqProof;
    try {
        dleqProof = parseDleqProof(atob(bp.P));
    } catch(e) {
        console.error(PARSE_ERR);
        return;
    }
    return dleqProof;
}

// Decode proof string and remove prefix
function getMarshaledBatchProof(proof) {
    let proofStr = atob(proof);
    if (proofStr.indexOf(BATCH_PROOF_PREFIX) === 0) {
        proofStr = proofStr.substring(BATCH_PROOF_PREFIX.length);
    }
    return JSON.parse(proofStr);
}

// Decode the proof that is sent into a map
//
// input: Marshaled proof string
// output: DLEQ proof
function parseDleqProof(proofStr) {
    const dleqProofM = JSON.parse(proofStr);
    let dleqProof = new Map();
    dleqProof.R = getBigNumFromB64(dleqProofM.R);
    dleqProof.C = getBigNumFromB64(dleqProofM.C);
    return dleqProof;
}

// Return a bignum from a base-64 encoded string
function getBigNumFromB64(b64Str) {
    let bits = sjcl.codec.base64.toBits(b64Str);
    return sjcl.bn.fromBits(bits);
}

// Return a big number from an array of bytes
function getBigNumFromBytes(bytes) {
    let bits = sjcl.codec.bytes.toBits(bytes);
    return sjcl.bn.fromBits(bits);
}

// Return a bignum from a hex string
function getBigNumFromHex(hex) {
    return sjcl.bn.fromBits(sjcl.codec.hex.toBits(hex));
}

// PRNG encode point
function encodePointForPRNG(point) {
    let hex = sjcl.codec.hex.fromBits(point.toBits());
    let newHex = UNCOMPRESSED_POINT_PREFIX + hex;
    return sjcl.codec.hex.toBits(newHex);
}

// Retrieves the commitments from the GH beacon and sets them as global variables
// (we return the xhr object for testing purposes)
function setActiveCommitments() {
    let xhr = new XMLHttpRequest();
    xhr.onreadystatechange = function() {
        // Parse as JSON and retrieve commitments
        if (xhr.status < 300 && xhr.readyState == 4) {
            const respBody = xhr.responseText;
            let resp = JSON.parse(respBody);
            let comms = resp[COMMITMENTS_KEY];
            if (comms) {
                if (DEV) {
                    activeG = comms["dev"]["G"];
                    activeH = comms["dev"]["H"];
                } else {
                    activeG = comms["1.0"]["G"];
                    activeH = comms["1.0"]["H"];
                }
            }
        }
    };
    xhr.open("GET", COMMITMENT_URL, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.send();
    return xhr;
}