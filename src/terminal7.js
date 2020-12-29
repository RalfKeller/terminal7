/*! Terminal 7
 *  This file contains the code that makes terminal 7 - a webrtc based
 *  touchable terminal multiplexer.
 *
 *  Copyright: (c) 2020 Benny A. Daon - benny@tuzig.com
 *  License: GPLv3
 */
import { Gate } from './gate.js'
import { Window } from './window.js'
import { v4 as uuidv4 } from 'uuid'
import * as Hammer from 'hammerjs'
import * as TOML from '@iarna/toml'
import * as imageMapResizer from './imageMapResizer.js'
import CodeMirror from 'codemirror/src/codemirror.js'
import { vimMode } from 'codemirror/keymap/vim.js'
import { tomlMode} from 'codemirror/mode/toml/toml.js'
import { dialogAddOn } from 'codemirror/addon/dialog/dialog.js'
import { formatDate } from './utils.js'
import { Plugins } from '@capacitor/core'

const { Network, App, BackgroundTask } = Plugins

const DEFAULT_DOTFILE = `[theme]
foreground = "#00FAFA"
background = "#000"
selection = "#D9F505"

[indicators]
flash = 100
log_lines = 7

[exec]
shell = "zsh"

[net]
timeout = 3000
retries = 3
ice_server = "stun:stun2.l.google.com:19302"

[ui]
quickest_press = 1000
max_tabs = 3
cut_min_distance = 80
cut_min_speed = 2.5
`

export class Terminal7 {
    /*
     * Terminal7 constructor, all properties should be initiated here
     */
    constructor(settings) {
        settings = settings || {}
        this.gates = []
        this.cells = []
        this.timeouts = []
        this.activeG = null
        window.terminal7 = this
        let dotfile = localStorage.getItem('dotfile') || DEFAULT_DOTFILE
        this.scrollLingers4     = settings.scrollLingers4 || 2000
        this.shortestLongPress  = settings.shortestLongPress || 1000
        this.borderHotSpotSize  = settings.borderHotSpotSize || 30
        this.token = localStorage.getItem("token")
        this.confEditor = null
        this.flashTimer = null
        this.netStatus = null
        this.loadConf(TOML.parse(dotfile))
    }
    /*
     * Terminal7.open opens terminal on the given DOM element,
     * loads the gates from local storage and redirects to home
     */
    open(e) {
        if (!e) {
            // create the container element
            e = document.createElement('div')
            e.id = "terminal7"
            document.body.appendChild(e)
        }
        this.e = e
        window.onresize = () => 
            terminal7.run(_ => {
                let H = document.body.offsetHeight
                if (H != this.bodyH) {
                    // height change. need to change height
                    this.bodyH = H
                    // resize each rootLayout on each window on each gate
                    var sy = 0
                    this.gates.forEach(g =>
                        g.windows.forEach(w => {
                            if (sy == 0) {
                                let tabbar = g.e.querySelector(".tabbar"),
                                r = tabbar.getBoundingClientRect()
                                sy = (r.y + 2)/H
                            }
                            w.rootLayout.sy = sy
                        }))
                }
                this.gates.forEach(g => g.fit())
                imageMapResizer()
            }, 50)
        // buttons
        document.getElementById("trash-button")
                .addEventListener("click",
                    ev => this.activeG.activeW.activeP.close())
        document.getElementById("home-button")
                .addEventListener("click", ev => this.goHome())
        document.getElementById("log-button")
                .addEventListener("click", ev => this.logDisplay())
        document.getElementById("search-button")
                .addEventListener("click", ev => 
                    this.activeG && this.activeG.activeW.activeP.toggleSearch())
        document.getElementById("dotfile-button")
                .addEventListener("click", ev => this.editDotfile(ev))
        document.getElementById("help-button")
                .addEventListener("click", ev => {
                    var helpId = (this.activeG)? "help-gate":"help-home",
                        ecl = document.getElementById(helpId).classList,
                        bcl = document.getElementById("help-button").classList,
                        hidden = ecl.contains("hidden")
                    ecl.toggle("hidden")
                    bcl.toggle("on")
                    if (hidden)
                        imageMapResizer()
                    else
                        this.focus()
                    // TODO: When at home remove the "on" from the home butto
                })
        // display the home page, starting with the plus button
        let addHost = document.getElementById("add-host")
        document.getElementById('plus-host').addEventListener(
            'click', ev => {
                addHost.querySelector("form").reset()
                addHost.classList.remove("hidden")
            })
        addHost.querySelector("form").addEventListener('submit', (ev) => {
            ev.preventDefault()
            let remember = addHost.querySelector('[name="remember"]').checked,
                gate = this.addGate({
                    addr: addHost.querySelector('[name="hostaddr"]').value,
                    name: addHost.querySelector('[name="hostname"]').value,
                    store: remember
                })
            if (typeof gate == "string")
                this.notify(gate)
            else {
                this.clear()
                gate.connect()
            }
        })
        // hide the modal on xmark click
        addHost.querySelector(".close").addEventListener('click',  ev =>  {
            this.clear()
        })
        this.gates.forEach(gate => {
            gate.open(e)
            gate.e.classList.add("hidden")
        })
        // Handle network events for the indicator
        Network.getStatus().then(s => this.updateNetworkStatus(s))
        Network.addListener('networkStatusChange', s => {
            if (!s.connected)
                this.gates.forEach(g => g.clear())
            this.updateNetworkStatus(s)
        })
        this.catchFingers()
        // setting up edit host events
        let editHost = document.getElementById("edit-host")
        editHost.querySelector("form").addEventListener('submit', ev => {
            ev.preventDefault()
            editHost.gate.editSubmit(ev)
        })
        editHost.querySelector(".close").addEventListener('click',  ev =>
            terminal7.clear())
        editHost.querySelector(".trash").addEventListener('click',  ev => {
            editHost.gate.delete()
            terminal7.clear()
        })
        editHost.querySelector(".reset").addEventListener('click',  ev => {
            this.clear()
            editHost.gate.showResetHost(ev)
        })
        // setting up reset host event
        let resetHost = document.getElementById("reset-host")
        resetHost.querySelector("form").addEventListener('submit', ev => {
            ev.preventDefault()
            editHost.gate.restartServer()
        })
        resetHost.querySelector(".close").addEventListener('click',  ev =>
            ev.target.parentNode.parentNode.parentNode.classList.add("hidden"))
        this.goHome()
        document.addEventListener("keydown", ev => {
            if (ev.key == "Meta") {
                this.metaPressStart = Date.now()
                this.run(_ => {
                    let e = document.getElementById('keys-help')
                    if (!this.conf.features["copy_mode"])
                        e.querySelectorAll('.copy_mode').forEach(i =>
                            i.style.display = "none")
                    if (Date.now() - this.metaPressStart > 987)
                        e.classList.remove('hidden')
                }, terminal7.conf.ui.quickest_press)
            } else
                this.metaPressStart = Number.MAX_VALUE
        })
        document.addEventListener("keyup", ev => {
            // hide the keys help when releasing any key
            document.getElementById('keys-help').classList.add('hidden')
            this.metaPressStart = Number.MAX_VALUE
        })
        // Load gates from local storage
        let hs = JSON.parse(localStorage.getItem('gates'))
        if (hs != null)
            hs.forEach((p) => {
                p.store = true
                this.addGate(p)
            })
        // window.setInterval(_ => this.periodic(), 2000)
        App.addListener('appStateChange', state => {
            if (!state.isActive) {
                // We're getting suspended. disengage.
                let taskId = BackgroundTask.beforeExit(async () => {
                    console.log("Benched. Disengaging from all gates")
                    this.disengage(() => {
                        console.log("finished disengaging")
                        this.clearTimeouts()
                        BackgroundTask.finish({taskId})
                    })
                })
            }
            else {
                // We're back! ensure we have the latest network status and 
                // reconnect to the active gate
                console.log("Active ☀️")
                this.clearTimeouts()
                Network.getStatus().then(s => this.updateNetworkStatus(s))
            }
        })
            
        // Last one: focus
        this.focus()
    }
    editDotfile(ev) {
        var modal   = document.getElementById("settings-modal"),
            button  = document.getElementById("dotfile-button"),
            area    =  document.getElementById("edit-conf"),
            conf    =  localStorage.getItem("dotfile") || DEFAULT_DOTFILE

        area.value = conf

        button.classList.add("on")
        modal.classList.remove("hidden")

        if (terminal7.confEditor == null) {
            // initialize the editor
            vimMode(CodeMirror)
            tomlMode(CodeMirror)
            dialogAddOn(CodeMirror)
            CodeMirror.commands.save = _ => this.saveConf()
            // TODO: the next 2 lines do nothing fixed them and support :q
            CodeMirror.commands.wq = _ => this.saveConf()
            CodeMirror.commands.q = _ => modal.classList.add("hidden")
            terminal7.confEditor  = CodeMirror.fromTextArea(area, {
               value: conf,
               lineNumbers: true,
               mode: "toml",
               keyMap: "vim",
               matchBrackets: true,
               showCursorWhenSelecting: true
            })
            modal.querySelector(".close").addEventListener('click',
                ev => {
                    button.classList.remove("on")
                    this.clear()
                    this.focus()
                }
            )
            modal.querySelector(".save").addEventListener('click',
                ev => { 
                    this.saveConf()
                    this.focus()
                })
            modal.querySelector(".copy").addEventListener('click',
                ev => {
                    var area =  document.getElementById("edit-conf")
                    terminal7.confEditor.save()
                    cordova.plugins.clipboard.copy(area.value);
                    this.focus()
                })
        }
        terminal7.confEditor.focus()
    }
    /*
     * saveConf saves the configuration and closes open conf editor
     */
    saveConf() {
        var button  = document.getElementById("dotfile-button"),
            area    =  document.getElementById("edit-conf")
        button.classList.remove("on")
        terminal7.confEditor.save()
        this.loadConf(TOML.parse(area.value))
        localStorage.setItem("dotfile", area.value)
        this.cells.forEach(c => {
            if (typeof(c.setTheme) == "function")
                c.setTheme(this.conf.theme)
        })
        this.clear()
    }
    /*
     * terminal7.onTouch is called on all browser's touch events
     */
    onTouch(type, ev) {
        let e = ev.target,
            pane = e.p,
            nameB = e.gate && e.gate.nameE.parentNode.parentNode
        if (type == "start") {
            this.touch0 = Date.now() 
            this.firstT = this.lastT = ev.changedTouches
            window.toBeFit = new Set([])
            if (e.gate instanceof Gate)
                nameB.classList.add("pressed")
            if (e.w instanceof Window)
                e.classList.add("pressed")
            return 
        } else if (type == "cancel") {
            this.touch0 = null
            this.firstT = []
            this.lastT = []
            this.gesture = null
            if (e.gate instanceof Gate)
                nameB.classList.remove("pressed")
            return
        }

        let x  = ev.changedTouches[0].pageX,
            y  = ev.changedTouches[0].pageY

        if (this.firstT.length == 0)
            return

        let dx = this.firstT[0].pageX - x,
            dy = this.firstT[0].pageY - y,
            d  = Math.sqrt(Math.pow(dx, 2) + Math.pow(dy, 2)),
            deltaT = Date.now() - this.touch0,
            s  = d/deltaT,
            r = Math.abs(dx / dy),
            topb  = r < 1.0


        if (e.gate instanceof Gate) {
            let longPress = terminal7.conf.ui.quickest_press
            if (deltaT > longPress) {
                nameB.classList.remove("pressed")
                e.gate.edit()
            }
            if (type == 'end')
                nameB.classList.remove("pressed")
            return
        }
        if (e.w instanceof Window) {
            let longPress = terminal7.conf.ui.quickest_press
            if (deltaT > longPress) {
                e.classList.remove("pressed")
                e.w.rename()
                return
            }
            if (type == 'end') {
                e.classList.remove("pressed")
                e.w.focus()
            }
            return
        }


        if (pane === undefined)  {
            return
        }
        let lx = (x / document.body.offsetWidth - pane.xoff) / pane.sx,
            ly = (y / document.body.offsetHeight - pane.yoff) / pane.sy
        if (type == "move") {
            if (this.gesture == null) {
                let rect = pane.e.getBoundingClientRect()
                console.log(x, y, rect)
                // identify pan event on a border
                if (Math.abs(rect.x - x) < this.borderHotSpotSize)
                    this.gesture = "panborderleft"
                else if (Math.abs(rect.right - x) < this.borderHotSpotSize) 
                    this.gesture = "panborderright"
                else if (Math.abs(y - rect.y) < this.borderHotSpotSize)
                    this.gesture = "panbordertop"
                else if (Math.abs(y - rect.bottom) < this.borderHotSpotSize)
                    this.gesture = "panborderbottom"
                else 
                    return
                console.log(`identified: ${this.gesture}`)
            } 
            if (this.gesture.startsWith("panborder")) {
                let where = this.gesture.slice(9),
                    dest = ((where == "top") || (where == "bottom"))
                            ? y / document.body.offsetHeight
                            : x / document.body.offsetWidth
                if (dest > 1.0)
                    dest = 1.0
                console.log(`moving ${where} border of #${pane.id} to ${dest}`)
                pane.layout.moveBorder(pane, where, dest)
            }
            this.lastT = ev.changedTouches
        }
        if (type == "end") {
            window.toBeFit.forEach(c => c.fit())
            window.toBeFit = new Set([])
            if ((!pane.scrolling)
                && (ev.changedTouches.length == 1)
                && (d > this.conf.ui.cutMinDistance)
                && (s > this.conf.ui.cutMinSpeed)) {
                    // it's a swipe!!
                    let p = ev.target.p
                    if (!pane.zoomed)  {
                        let t = pane.split((topb)?"topbottom":"rightleft",
                                           (topb)?lx:ly)
                        // t.focus()
                    }
                }
            this.touch0 = null
            this.firstT = []
            this.gesture = null
        }
    }
    catchFingers() {
        var start,
            last,
            firstT = [],
            gesture = null
        this.e.addEventListener("touchstart", ev =>
            this.onTouch("start", ev), false)
        this.e.addEventListener("touchend", ev =>
            this.onTouch("end", ev), false)
        this.e.addEventListener("touchcancel", ev =>
            this.onTouch("cancel", ev), false)
        this.e.addEventListener("touchmove", ev =>
            this.onTouch("move", ev), false)
    }
    /*
     * Terminal7.addGate is used to add a gate to a host.
     * the function ensures the gate has a unique name adds the gate to
     * the `gates` property, stores and returns it.
     */
    addGate(props) {
        let out = [],
            p = props || {},
            addr = p.addr,
            nameFound = false
        // add the id
        p.id = this.gates.length
        p.verified = false

        // if no port specify, use the default port
        if (addr && (addr.indexOf(":") == -1))
            p.addr = `${addr}:7777`

        this.gates.forEach(i => {
            if (props.name == i.name)
                nameFound = true
        })
        if (nameFound) {
            return "Gate name is not unique"
        }

        let g = new Gate(p)
        console.log(`adding ${g.user}@${g.addr} & saving gates`)
        this.gates.push(g)
        if (p.store)
            this.storeGates()
        this.storeGates()
        g.open(this.e)
        return g
    }
    storeGates() { 
        let out = []
        this.gates.forEach((h) => {
            if (h.store) {
                let ws = []
                h.windows.forEach((w) => ws.push(w.id))
                out.push({id: h.id, addr: h.addr, user: h.user, secret: h.secret,
                    name:h.name, windows: ws})
            }
        })
        console.log("Storing gates:", out)
        localStorage.setItem('gates', JSON.stringify(out))
    }
    clear() {
        this.e.querySelectorAll('.temporal').forEach(e => e.remove())
        this.e.querySelectorAll('.modal').forEach(e => {
            if (!e.classList.contains("non-clearable"))
                e.classList.add("hidden")
        })
    }
    goHome() {
        let s = document.getElementById('home-button'),
            h = document.getElementById('home'),
            hc = document.getElementById('downstream-indicator')
        s.classList.add('on')
        hc.classList.add('off')
        hc.classList.remove('on', 'failed')
        // we need a token
        if (this.token == null) {
            this.token = uuidv4()
            localStorage.setItem('token', this.token)
        }
        if (this.activeG) {
            this.activeG.e.classList.add("hidden")
            this.activeG = null
        }
        // hide the modals
        this.clear()
        // trash and search are off
        document.getElementById("search-button").classList.add("off")
        document.getElementById("trash-button").classList.add("off")
        window.location.href = "#home"
    }
    /* 
     * Terminal7.logDisplay display or hides the notifications.
     * if the parameters in udefined the function toggles the displays
     */
    logDisplay(show) {
        let e = document.getElementById("log")
        if (show === undefined)
            // if show is undefined toggle current state
            show = e.classList.contains("fade-out")
        if (show) {
            e.classList.remove("fade-out", "hidden")
            document.getElementById("log-button")
                .classList.add("on")
        } else {
            e.classList.add("fade-out")
            document.getElementById("log-button")
                .classList.remove("on")
        }
        this.focus()
    }
    /*
     * OnMessage is called by the pane when they recieve traffic.
     * if the indicator is not alreay flushing it will flush it
     */
    onMessage(m) {
        if (this.flashTimer == null) {
            let  e = document.getElementById("downstream-indicator"),
                 flashTime = this.conf.indicators && this.conf.indicators.flash
                             || 88
            e.classList.remove("failed", "off")
            e.classList.add("on")
            this.flashTimer = terminal7.run(_ => {
                this.flashTimer = null
                e.classList.remove("on")
                e.classList.add("off")
            }, flashTime) 
        }
    }
    /*
     * onDisconnect is called when a gate disconnects.
     */
    onDisconnect(gate) {
            let e = document.getElementById("disconnect-template")
            e = e.content.cloneNode(true)
            this.clear()
            // clear pending messages to let the user start fresh
            this.pendingCDCMsgs = []
            e.querySelector("h1").textContent =
                `${gate.name} communication failure`
            e.querySelector("form").addEventListener('submit', ev => {
                this.clear()
                gate.boarding = false
                gate.clear()
                gate.connect()
            })
            e.querySelector(".close").addEventListener('click', ev => {
                terminal7.goHome()
            })
            this.e.appendChild(e)
    }
    /*
     * focus restores the focus to the ative pane, if there is one
     */
    focus() {
        if (this.activeG && this.activeG.activeW &&
            this.activeG.activeW.activeP)
            this.activeG.activeW.activeP.focus()
        else
            this.e.focus()
    }
    ssh(e, gate, cmd, cb) {
        let uname = e.querySelector('[name="uname"]').value,
            pass = e.querySelector('[name="pass"]').value,
            addr = gate.addr.substr(0, gate.addr.indexOf(":"))
        this.notify("ssh is connecting...")
        window.cordova.plugins.sshConnect.connect(uname, pass, addr, 22,
            resp => {
                this.notify("ssh connected")
                if (resp) {
                    let token = terminal7.token
                    // TODO: make it work with non-standrad webexec locations
                    window.cordova.plugins.sshConnect.executeCommand(
                        cmd, 
                        msg =>  {
                            this.notify("ssh executed command success")
                            if (typeof cb === "function")
                                cb(msg)
                        },
                        msg => this.notify(`ssh failed: ${msg}`))
                    window.cordova.plugins.sshConnect.disconnect()
                }
            }, ev => {
                if (ev == "Connection failed. Could not connect")
                    if (gate.verified)
                        this.notify(ev)
                    else
                        this.notify(`Failed the connect. Maybe ${gate.addr} is wrong`)
                else
                    this.notify("Wrong password")
                console.log("ssh failed to connect", ev)
            })
    }
    onNoSignal(gate) {
        let e = document.getElementById("nosignal-template")
        e = e.content.cloneNode(true)
        this.clear()
        // clear pending messages to let the user start fresh
        this.pendingCDCMsgs = []
        e.querySelectorAll(".name").forEach(e => e.textContent = gate.name)
        e.querySelectorAll(".address").forEach(e => e.textContent = gate.addr)
        e.querySelector(".edit-link").addEventListener('click', _ => {
            this.clear()
            gate.edit()
        })
        e.querySelector("form").addEventListener('submit', ev => {
            ev.preventDefault()
            this.ssh(this.e.lastElementChild, gate, 
                "webexec start", ev => {
                gate.clear()
                this.clear()
                terminal7.run(_ => gate.connect(), 2000)
            })
        })
        e.querySelector(".close").addEventListener('click', ev => {
            gate.closePC()
            gate.clear()
            terminal7.goHome()
        })
        this.e.appendChild(e)
    }
    /*
     * noitify adds a message to the teminal7 notice board
     */
    notify(message) {    
        let ul = document.getElementById("log-msgs"),
            li = document.createElement("li"),
            d = new Date(),
            t = formatDate(d, "HH:mm:ss.fff")

        let lines = ul.querySelectorAll('li')
        if (lines.length > terminal7.conf.indicators.log_lines)
            lines[0].remove()
        li.innerHTML = `<time>${t}</time><p>${message}</p>`
        li.classList = "log-msg"
        ul.appendChild(li)
        terminal7.logDisplay(true)
    }
    run(cb, delay) {
        var i = this.timeouts.length,
            r = window.setTimeout(ev => {
                this.timeouts.splice(i, 1)
                cb(ev)
            }, delay)
        this.timeouts.push(r)
        return r
    }
    clearTimeouts() {
        this.timeouts.forEach(t => window.clearTimeout(t))
        this.timeouts = []
    }
    periodic() {
        var now = new Date()
        this.gates.forEach(g => {
            if (g.periodic instanceof Function) 
                g.periodic(now)
        })
    }
    /*
     * disengage gets each active gate to disengae
     */
    disengage(cb) {
        var count = 0
        this.gates.forEach(g => {
            if (g.boarding) {
                count++
                g.disengage(_ => count--)
            }
        })
        let callCB = () => terminal7.run(() => {
            if (count == 0)
                cb()
             else 
                callCB()
        }, 10)
        callCB()
    }
    updateNetworkStatus (status) {
        let cl = document.getElementById("connectivity").classList,
            offl = document.getElementById("offline").classList
        this.netStatus = status
        console.log(`updateNetwrokStatus: ${status.connected}`)
        if (status.connected) {
            cl.remove("failed")
            offl.add("hidden")
            this.clear()
            if (this.activeG)
                this.activeG.connect()
        }
        else {
            offl.remove("hidden")
            cl.add("failed")
            // remove all restore markers
        }
    }
    loadConf(conf) {
        this.conf = conf
        this.conf.features = this.conf.features || {}
        this.conf.ui = this.conf.ui || {}
        this.conf.net = this.conf.net || {}
        this.conf.ui.quickest_press = this.conf.ui.quickest_press || 1000
        this.conf.ui.max_tabs = this.conf.ui.max_tabs || 3
        this.conf.ui.cutMinSpeed = this.conf.ui.cut_min_speed || 2.2
        this.conf.ui.cutMinDistance = this.conf.ui.cut_min_distance || 50
        this.conf.net.iceServer = this.conf.net.ice_server ||
            "stun:stun2.l.google.com:19302"
        this.conf.net.timeout = this.conf.net.timeout || 3000
        this.conf.net.retries = this.conf.net.retries || 3
    }
}
