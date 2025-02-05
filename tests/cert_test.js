/* Terminal 7 Ceritificate tests
 *
 *  Copyright: (c) 2020 Benny A. Daon - benny@tuzig.com
 *  License: GPLv3
 */
import { Terminal7 } from "../src/terminal7.js"
import { assert } from "chai"
import { deleteDB } from 'idb'

describe("certificates", () => {
    var t, ns
    /*
     * Every tests gets a fresh copy of terminal7 and a fresh dom element
     */
    beforeEach(async () => {
        await deleteDB('t7')
        ns = []
        t = new Terminal7()
        t.notify = msg => ns.push(msg)
    })
    after(() => terminal7.clearTimeouts())
    it("can be create, stored and read", async () => {
        let fp = await t.getFingerprint()
        expect(t.certificates.length).to.equal(0)
        let certs = await t.generateCertificate()
        expect(certs.length).to.equal(1)
        await t.storeCertificate()
        fp = await t.getFingerprint()
        expect(t.certificates.length).to.equal(1)
        let fingerprint = await t.getFingerprint()
        expect(fingerprint.length).to.equal(64)
    })
})
