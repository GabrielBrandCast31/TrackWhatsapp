/*! Tag de jornada Web -> WhatsApp. Instale uma vez, antes do </head>:
 *  <script async src="https://SEU.DOMINIO/t/tl.js?k=CHAVE"></script>
 *
 * O que ela faz:
 *  - gera ou recupera o TL_ID (o ID da jornada) e persiste em cookie, localStorage,
 *    sessionStorage e window.tracklabs — nunca um ID novo por pagina;
 *  - guarda UTMs em first touch e last touch (visita direta nao apaga origem);
 *  - captura fbclid/_fbp/_fbc, gclid/gbraid/wbraid/gad_source, ttclid/_ttp e GA4;
 *  - registra page_view, click_whatsapp, click_phone, click_email, click_instagram,
 *    form_start e form_submit (e o que voce mandar por tracklabs.track);
 *  - mantem ?tl= nos links internos e anexa a referencia na mensagem do WhatsApp.
 */
(function (w, d) {
  'use strict'
  if (w.tracklabs && w.tracklabs.__loaded) return

  var KEY = '__SITE_KEY__'
  var ENDPOINT = '__ENDPOINT__'
  var script = d.currentScript
  if (script && script.src) {
    try {
      var u = new URL(script.src)
      ENDPOINT = u.origin + '/t/collect'
      KEY = u.searchParams.get('k') || KEY
    } catch (e) {}
  }
  var cfg = w.tracklabsConfig || {}
  // 'tl' (padrao) anexa tl=<TL_ID>; 'protocol' anexa um protocolo curto (TL-8F3K2Q)
  var REF_MODE = cfg.reference === 'protocol' ? 'protocol' : 'tl'
  var TWO_YEARS = 63072000
  var SESSION_MS = 30 * 60 * 1000
  var UTM = ['source', 'medium', 'campaign', 'content', 'term']
  var CLICK = ['fbclid', 'gclid', 'gbraid', 'wbraid', 'gad_source', 'ttclid']
  var TL_RE = /^[A-Za-z0-9][A-Za-z0-9_\-]{7,63}$/

  // ---------- storage: cookie + localStorage + sessionStorage ----------
  function getCookie(name) {
    var m = d.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'))
    return m ? decodeURIComponent(m[1]) : null
  }
  function setCookie(name, value, maxAge) {
    var parts = location.hostname.split('.')
    // cookie no dominio raiz: www.site.com e site.com dividem a jornada
    var domain = parts.length > 1 && !/^\d+$/.test(parts[parts.length - 1]) ? '; domain=.' + parts.slice(-2).join('.') : ''
    if (/\.(com|net|org|gov|edu)\.[a-z]{2}$/.test(location.hostname)) domain = '; domain=.' + parts.slice(-3).join('.')
    var base = name + '=' + encodeURIComponent(value) + '; path=/; max-age=' + maxAge + '; SameSite=Lax'
    d.cookie = base + domain
    if (getCookie(name) !== value) d.cookie = base
  }
  function ls(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k)
      localStorage.setItem(k, v)
    } catch (e) {}
    return null
  }
  function ss(k, v) {
    try {
      if (v === undefined) return sessionStorage.getItem(k)
      sessionStorage.setItem(k, v)
    } catch (e) {}
    return null
  }
  function readJSON(k) {
    try {
      return JSON.parse(ls(k) || getCookie(k) || 'null')
    } catch (e) {
      return null
    }
  }
  function saveJSON(k, obj) {
    var raw = JSON.stringify(obj)
    ls(k, raw)
    if (raw.length < 1500) setCookie(k, raw, TWO_YEARS)
  }

  function rand(n) {
    var s = ''
    while (s.length < n) s += Math.floor(Math.random() * 1e9).toString()
    return s.slice(0, n)
  }
  function newTl() {
    return Date.now() + '_' + Date.now() + rand(1)
  }
  function newProtocol() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    var out = ''
    for (var i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)]
    return 'TL-' + out
  }

  var params = new URLSearchParams(location.search)

  // ---------- TL_ID: existe? reutiliza. nao existe? gera e persiste ----------
  var fromUrl = params.get('tl')
  var tl = (fromUrl && TL_RE.test(fromUrl) && fromUrl) || getCookie('_tl') || ls('_tl') || ss('_tl')
  if (!tl || !TL_RE.test(tl)) tl = newTl()
  setCookie('_tl', tl, TWO_YEARS)
  ls('_tl', tl)
  ss('_tl', tl)

  var visitor = getCookie('_tlv') || ls('_tlv')
  if (!visitor) visitor = 'v' + Date.now().toString(36) + rand(8)
  setCookie('_tlv', visitor, TWO_YEARS)
  ls('_tlv', visitor)

  // sessao: 30 min de inatividade
  var sess = readJSON('_tls') || {}
  var now = Date.now()
  if (!sess.id || now - (sess.at || 0) > SESSION_MS) sess = { id: 's' + now.toString(36) + rand(5), n: (sess.n || 0) + 1 }
  sess.at = now
  saveJSON('_tls', sess)

  // ---------- atribuicao ----------
  var current = {}
  UTM.forEach(function (f) {
    var v = params.get('utm_' + f)
    if (v) current[f] = v
  })
  var clicks = readJSON('_tlc') || {}
  var hasClick = false
  CLICK.forEach(function (f) {
    var v = params.get(f)
    if (v) {
      clicks[f] = v
      hasClick = true
    }
  })
  var hasSignal = !!current.source || hasClick
  if (hasSignal && !current.source) {
    if (params.get('gclid') || params.get('gbraid') || params.get('wbraid')) current = { source: 'google', medium: 'cpc' }
    else if (params.get('fbclid')) current = { source: 'facebook', medium: 'paid' }
    else if (params.get('ttclid')) current = { source: 'tiktok', medium: 'paid' }
  }
  saveJSON('_tlc', clicks)

  var first = readJSON('_tlf')
  if (!first && hasSignal) {
    first = current
    saveJSON('_tlf', first)
  }
  var last = readJSON('_tll')
  // last touch so anda com origem de verdade: direct / none nao substitui
  if (hasSignal) {
    last = current
    saveJSON('_tll', last)
  }

  // landing page = primeira pagina da sessao do navegador
  var landing = ss('_tlland')
  if (!landing) {
    landing = location.pathname
    ss('_tlland', landing)
  }

  function metaIds() {
    var fbp = getCookie('_fbp')
    var fbc = getCookie('_fbc')
    // _fbc so e montado quando existe um fbclid real: nunca inventar identificador
    if (!fbc && clicks.fbclid) {
      fbc = 'fb.1.' + Date.now() + '.' + clicks.fbclid
      setCookie('_fbc', fbc, 7776000)
    }
    return { fbp: fbp, fbc: fbc, ttp: getCookie('_ttp') }
  }

  function ga4() {
    var out = {}
    var ga = getCookie('_ga')
    if (ga) {
      var p = ga.split('.')
      if (p.length >= 4) out.client_id = p[2] + '.' + p[3]
    }
    var m = d.cookie.match(/(?:^|; )_ga_[A-Z0-9]+=([^;]*)/)
    if (m) {
      var v = decodeURIComponent(m[1])
      var gs2 = v.match(/s(\d+)\$o(\d+)/)
      if (gs2) {
        out.session_id = gs2[1]
        out.session_number = gs2[2]
      } else {
        var p2 = v.split('.')
        if (p2.length > 3) {
          out.session_id = p2[2]
          out.session_number = p2[3]
        }
      }
    }
    return out
  }

  // ---------- envio ----------
  function send(name, props, extra) {
    var ids = metaIds()
    var ev = {
      k: KEY,
      tl: tl,
      visitor_id: visitor,
      session_id: sess.id,
      event_id: 'e' + Date.now().toString(36) + rand(6),
      event_name: name,
      event_time: new Date().toISOString(),
      page_url: location.href,
      page_path: location.pathname,
      page_title: d.title,
      page_referrer: d.referrer || null,
      landing_page: landing,
      hostname: location.hostname,
      utm: current,
      first_touch: first || {},
      last_touch: last || {},
      click_ids: {
        fbclid: clicks.fbclid,
        fbp: ids.fbp,
        fbc: ids.fbc,
        gclid: clicks.gclid,
        gbraid: clicks.gbraid,
        wbraid: clicks.wbraid,
        gad_source: clicks.gad_source,
        ttclid: clicks.ttclid,
        ttp: ids.ttp,
      },
      ga: ga4(),
      props: props || {},
    }
    if (extra) for (var x in extra) ev[x] = extra[x]
    var body = JSON.stringify(ev)
    try {
      // text/plain nao dispara preflight de CORS: o evento sai mesmo saindo da pagina
      if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain' }))) return ev
    } catch (e) {}
    try {
      fetch(ENDPOINT, { method: 'POST', body: body, keepalive: true, mode: 'no-cors', headers: { 'Content-Type': 'text/plain' } })
    } catch (e) {}
    return ev
  }

  // ---------- propagacao do tl ----------
  var WA_RE = /(^|\.)(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|whatsapp\.com)$/i

  function isWhatsApp(url) {
    return url.protocol === 'whatsapp:' || WA_RE.test(url.hostname)
  }

  /** Anexa a referencia da visita no texto da mensagem do WhatsApp. */
  function whatsappUrl(href, protocol) {
    var url
    try {
      url = new URL(href, location.href)
    } catch (e) {
      return href
    }
    var ref = REF_MODE === 'protocol' ? 'Protocolo: ' + protocol : 'tl=' + tl
    var text = url.searchParams.get('text') || ''
    if (text.indexOf(tl) === -1 && text.indexOf(protocol) === -1) {
      text = (text ? text + '\n\n' : '') + ref
      url.searchParams.set('text', text)
    }
    return url.toString()
  }

  function waPhone(url) {
    var m = url.pathname.match(/\/(\d{8,15})/)
    return (m && m[1]) || url.searchParams.get('phone') || null
  }

  function onWhatsApp(href) {
    var url = new URL(href, location.href)
    var protocol = newProtocol()
    send('click_whatsapp', { href: href, wa_phone: waPhone(url) }, { protocol: protocol })
    return whatsappUrl(href, protocol)
  }

  function internal(url) {
    return url.hostname === location.hostname || url.hostname.split('.').slice(-2).join('.') === location.hostname.split('.').slice(-2).join('.')
  }

  d.addEventListener(
    'click',
    function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null
      if (!a) return
      var url
      try {
        url = new URL(a.getAttribute('href'), location.href)
      } catch (err) {
        return
      }
      if (isWhatsApp(url)) {
        a.href = onWhatsApp(a.href)
      } else if (url.protocol === 'tel:') {
        send('click_phone', { phone: url.pathname })
      } else if (url.protocol === 'mailto:') {
        send('click_email', { email: url.pathname })
      } else if (/(^|\.)instagram\.com$/i.test(url.hostname)) {
        send('click_instagram', { href: url.href })
      } else if (/^https?:$/.test(url.protocol) && internal(url) && !url.searchParams.get('tl')) {
        // CAMADA URL: o tl acompanha os links internos
        url.searchParams.set('tl', tl)
        a.href = url.toString()
      }
      var custom = a.getAttribute('data-tl-event')
      if (custom) send(custom, { href: url.href, label: a.textContent && a.textContent.trim().slice(0, 80) })
    },
    true,
  )

  // botao que abre o WhatsApp por JS (window.open) tambem carrega a referencia
  var nativeOpen = w.open
  w.open = function (href) {
    try {
      if (href && isWhatsApp(new URL(href, location.href))) arguments[0] = onWhatsApp(href)
    } catch (e) {}
    return nativeOpen.apply(w, arguments)
  }

  var started = typeof WeakSet === 'function' ? new WeakSet() : null
  d.addEventListener(
    'focusin',
    function (e) {
      var form = e.target && e.target.form
      if (!form || !started || started.has(form)) return
      started.add(form)
      send('form_start', { form: form.id || form.getAttribute('name') || null })
    },
    true,
  )
  d.addEventListener(
    'submit',
    function (e) {
      var form = e.target
      send('form_submit', { form: (form && (form.id || form.getAttribute('name'))) || null })
    },
    true,
  )

  // ---------- API publica ----------
  w.tracklabs = {
    __loaded: true,
    tl: tl,
    transaction_id: tl,
    visitor_id: visitor,
    session_id: sess.id,
    first_touch: first,
    last_touch: last,
    track: function (name, props) {
      return send(String(name), props)
    },
    whatsappUrl: function (href) {
      return whatsappUrl(href, newProtocol())
    },
  }

  send('page_view')
  var service = d.querySelector('[data-tl-service]')
  // um instante depois do page_view: a linha do tempo mostra a pagina antes do servico
  if (service) setTimeout(function () {
    send('view_service', { service: service.getAttribute('data-tl-service') })
  }, 50)
})(window, document)
