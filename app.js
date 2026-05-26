import { removeBackground } from
  'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/dist/index.mjs'

// ── Constants ────────────────────────────────────────────────────────────────

const CORS_PROXY    = 'https://corsproxy.io/?'
const WORKER_URL    = 'https://spring-night-4416.danielspsg.workers.dev'
const IMGLY_PATH    = 'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/dist/'

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  product:         null,
  productImgEl:    null,   // HTMLImageElement ready for drawImage
  templateConfig:  null,
  selectedTpl:     'T1',
  ready:           false,
}

// ── DOM ──────────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id)

const elUrl             = $('ml-url')
const elBtnFetch        = $('btn-fetch')
const elErrorMsg        = $('error-msg')
const elLoadingProduct  = $('loading-product')
const elLoadingBg       = $('loading-bg')
const elProgressBar     = $('progress-bar')
const elProgressLabel   = $('progress-label')
const elSectionFields   = $('section-fields')
const elSectionTemplates= $('section-templates')
const elSectionPreview  = $('section-preview')
const elSectionDownload = $('section-download')
const elTemplateGrid    = $('template-grid')
const elCanvas          = $('main-canvas')
const elBtnDownload     = $('btn-download')
const elWarningBg       = $('warning-bg')
const elIgHandle        = $('ig-handle')

const fields = {
  name:         $('f-name'),
  subtitle:     $('f-subtitle'),
  installments: $('f-installments'),
  price:        $('f-price'),
  badge:        $('f-badge'),
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const show = (...els) => els.forEach(el => el?.classList.remove('hidden'))
const hide = (...els) => els.forEach(el => el?.classList.add('hidden'))

function proxify(url) {
  return `${CORS_PROXY}${encodeURIComponent(url)}`
}

function extractItemId(text) {
  // Query params and hash fragment hold the specific listing ID.
  // Path-based /p/MLB... is the catalog product ID — not usable with /items/ API.
  try {
    const url = new URL(text)

    // 1. wid in the hash fragment (ML affiliate links put it after #)
    const hashParams = new URLSearchParams(url.hash.slice(1))
    const widHash = hashParams.get('wid')
    const mwh = widHash?.match(/MLB[\-]?(\d+)/i)
    if (mwh) return `MLB${mwh[1]}`

    // 2. item_id or wid in the query string
    for (const key of ['item_id', 'wid']) {
      const val = url.searchParams.get(key)
      const m = val?.match(/MLB[\-]?(\d+)/i)
      if (m) return `MLB${m[1]}`
    }

    // 3. pdp_filters encodes item_id:MLBXXXXXXX in the query string
    const filters = url.searchParams.get('pdp_filters') || ''
    const fm = filters.match(/item_id[:\s]+(MLB[\-]?\d+)/i)
    if (fm) {
      const m2 = fm[1].match(/MLB[\-]?(\d+)/i)
      if (m2) return `MLB${m2[1]}`
    }
  } catch {}

  // Fallback: scan raw text (handles /MLB-XXXXXXX- in path)
  const m = text.match(/MLB[\-]?(\d+)/i)
  return m ? `MLB${m[1]}` : null
}

// Resolves short/affiliate links (meli.la, etc.) by following the redirect
// via proxy. corsproxy.io exposes the final redirect URL in x-final-url header.
// Resolves short/affiliate links (meli.la, etc.) by following the redirect.
// corsproxy.io exposes the final redirect URL in x-final-url header.
// Throws a typed error so the caller can show a targeted message.
async function resolveItemId(inputUrl) {
  const direct = extractItemId(inputUrl)
  if (direct) return direct

  const res = await fetch(proxify(inputUrl))

  // corsproxy.io sets x-final-url to the last URL after following all redirects
  const finalUrl = res.headers.get('x-final-url') || ''

  // Detect profile/social page — no product ID extractable from this URL
  if (/mercadolivre\.com\.br\/social\//i.test(finalUrl)) {
    const err = new Error('profile_link')
    err.code = 'profile_link'
    throw err
  }

  const fromHeader = extractItemId(finalUrl)
  if (fromHeader) return fromHeader

  // Last resort: try to read the response body as plain text
  try {
    const text = await res.text()
    return extractItemId(text) || null
  } catch {
    return null
  }
}

function splitTitle(title) {
  if (!title) return ['', '']
  const words = title.toUpperCase().split(/\s+/)
  let split = -1
  for (let i = 2; i < words.length; i++) {
    // First word with a digit (e.g. "700ML", "400W") → specification starts here
    if (/\d/.test(words[i])) { split = i; break }
    // Short all-caps abbreviation after position 3 (e.g. "PEV", "XPT")
    if (i >= 3 && words[i].length <= 4 && /^[A-Z]+$/.test(words[i])) { split = i; break }
  }
  if (split < 0) split = Math.ceil(words.length / 2)
  return [words.slice(0, split).join(' '), words.slice(split).join(' ')]
}

function formatPrice(price) {
  return price.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function formatInstallments(inst) {
  if (!inst?.quantity) return ''
  const amt = inst.amount.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const noInterest = inst.rate === 0 || inst.free_shipping === true
  return `${inst.quantity}X R$${amt}${noInterest ? ' SEM JUROS' : ''}`
}

function debounce(fn, ms) {
  let t
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }
}

// ── Image loading ─────────────────────────────────────────────────────────────

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload  = () => resolve(img)
    img.onerror = () => reject(new Error(`load failed: ${src}`))
    img.src = src
  })
}

// ── ML API ────────────────────────────────────────────────────────────────────
// ML bloqueia /items/{id} de terceiros mesmo com OAuth.
// Estratégia: raspar o HTML da página do produto via corsproxy e extrair
// os dados estruturados (JSON-LD / Open Graph / meta tags).

const PROXY_LIST = [
  u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  u => `https://thingproxy.freeboard.io/fetch/${u}`,
]

async function fetchViaAnyProxy(url) {
  for (const proxyFn of PROXY_LIST) {
    try {
      const res = await fetch(proxyFn(url))
      if (!res.ok) continue
      const html = await res.text()
      if (!html.includes('suspicious-traffic-frontend') && html.length > 5000) return html
    } catch {}
  }
  return null
}

async function fetchProduct(itemId, originalUrl) {
  // Monta URL canônica se não temos a original
  const productUrl = originalUrl || `https://www.mercadolivre.com.br/p/${itemId}`

  const html = await fetchViaAnyProxy(productUrl)
  if (!html) throw new Error('bot_detection')

  // ── Tenta JSON-LD ──────────────────────────────────────────────────────────
  const ldMatches = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)]
  for (const m of ldMatches) {
    try {
      const ld = JSON.parse(m[1])
      const prod = Array.isArray(ld) ? ld.find(x => x['@type'] === 'Product') : (ld['@type'] === 'Product' ? ld : null)
      if (!prod) continue
      const price = parseFloat(prod.offers?.price ?? prod.offers?.lowPrice ?? 0)
      const imgUrl = Array.isArray(prod.image) ? prod.image[0] : prod.image
      return {
        title: prod.name || '',
        price,
        pictures: imgUrl ? [{ url: imgUrl }] : [],
        installments: null,
      }
    } catch {}
  }

  // ── Tenta Open Graph / meta tags ───────────────────────────────────────────
  const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1]
  const ogImage = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1]
  const priceTag = html.match(/<meta[^>]+itemprop="price"[^>]+content="([^"]+)"/i)?.[1]

  if (ogTitle && priceTag) {
    return {
      title: ogTitle,
      price: parseFloat(priceTag),
      pictures: ogImage ? [{ url: ogImage }] : [],
      installments: null,
    }
  }

  throw new Error('parse_failed')
}

// ── Background removal ───────────────────────────────────────────────────────

// Fallback: remove fundo branco/claro por flood-fill das bordas (canvas puro)
async function removeWhiteBackground(blob) {
  const tmpUrl = URL.createObjectURL(blob)
  const img = await new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = tmpUrl
  })
  URL.revokeObjectURL(tmpUrl)

  const w = img.naturalWidth, h = img.naturalHeight
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)

  const imageData = ctx.getImageData(0, 0, w, h)
  const data = imageData.data
  const threshold = 230

  // Considera pixel "claro" (fundo): já transparente ou RGB todos acima do threshold
  const isLight = idx => {
    const base = idx * 4
    return data[base + 3] < 20 ||
      (data[base] >= threshold && data[base + 1] >= threshold && data[base + 2] >= threshold)
  }

  const visited = new Uint8Array(w * h)
  const q = []

  const enqueue = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const idx = y * w + x
    if (visited[idx] || !isLight(idx)) return
    visited[idx] = 1
    q.push(idx)
  }

  // Semeia a fila a partir de todos os pixels de borda
  for (let x = 0; x < w; x++) { enqueue(x, 0); enqueue(x, h - 1) }
  for (let y = 1; y < h - 1; y++) { enqueue(0, y); enqueue(w - 1, y) }

  // BFS: zera o canal alpha de todos os pixels conectados ao fundo
  while (q.length) {
    const idx = q.pop()
    data[idx * 4 + 3] = 0
    const x = idx % w, y = (idx / w) | 0
    enqueue(x + 1, y); enqueue(x - 1, y); enqueue(x, y + 1); enqueue(x, y - 1)
  }

  ctx.putImageData(imageData, 0, 0)
  return new Promise(res => canvas.toBlob(res, 'image/png'))
}

async function removeProductBackground(originalUrl) {
  // Fetch image as blob via proxy to sidestep CORS on canvas + the WASM fetcher
  let blob
  try {
    const res = await fetch(proxify(originalUrl))
    if (!res.ok) throw new Error()
    blob = await res.blob()
  } catch {
    // Direct fallback
    const res = await fetch(originalUrl, { mode: 'cors' })
    blob = await res.blob()
  }

  try {
    const result = await removeBackground(blob, {
      publicPath: IMGLY_PATH,
      progress: (_key, current, total) => {
        if (total <= 0) return
        const pct = Math.round((current / total) * 100)
        elProgressBar.style.width = `${pct}%`
        elProgressLabel.textContent = `Processando imagem… ${pct}%`
      },
    })
    return URL.createObjectURL(result)
  } catch {
    // @imgly falhou → tenta remoção local por flood-fill
    elProgressLabel.textContent = 'Removendo fundo… (modo local)'
    const result = await removeWhiteBackground(blob)
    return URL.createObjectURL(result)
  }
}

// ── Canvas rendering ──────────────────────────────────────────────────────────

async function renderCanvas() {
  if (!state.ready || !state.templateConfig) return

  const tpl = state.templateConfig[state.selectedTpl]
  if (!tpl || tpl.placeholder) return

  const { w, h } = tpl.dimensions
  elCanvas.width  = w
  elCanvas.height = h

  const ctx = elCanvas.getContext('2d')
  ctx.clearRect(0, 0, w, h)

  await document.fonts.ready

  // 1. Template background
  try {
    const tplImg = await loadImage(tpl.file)
    ctx.drawImage(tplImg, 0, 0, w, h)
  } catch {
    ctx.fillStyle = '#1a1a1a'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#555'
    ctx.font = 'bold 48px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(`Template ${state.selectedTpl}`, w / 2, h / 2)
  }

  const f = tpl.fields

  // 2. Produto (por baixo do texto — texto fica por cima sempre)
  if (state.productImgEl) {
    const z     = tpl.product_zone
    const img   = state.productImgEl
    const scale = Math.min(z.w / img.width, z.h / img.height)
    const pw    = img.width  * scale
    const ph    = img.height * scale
    const px    = z.x + (z.w - pw) / 2
    const py    = z.y + (z.h - ph) / 2
    ctx.drawImage(img, px, py, pw, ph)
  }

  // 3–6. Campos de texto (sempre por cima do produto)
  function drawTextField(cfg, raw) {
    if (!cfg || !raw) return
    const text = cfg.transform === 'uppercase' ? raw.toUpperCase() : raw
    ctx.save()
    ctx.font         = cfg.font
    ctx.fillStyle    = cfg.color
    ctx.textAlign    = cfg.align || 'left'
    ctx.textBaseline = 'alphabetic'

    if (cfg.wrap) {
      const fontSize   = parseFloat(cfg.font.match(/(\d+(?:\.\d+)?)px/)?.[1] || '16')
      const lineHeight = cfg.line_height || Math.round(fontSize * 1.25)
      const maxW       = cfg.max_width || 9999
      const words      = text.split(' ')
      let line = '', y = cfg.y
      for (const word of words) {
        const test = line ? `${line} ${word}` : word
        if (ctx.measureText(test).width > maxW && line) {
          ctx.fillText(line, cfg.x, y)
          line = word; y += lineHeight
        } else { line = test }
      }
      if (line) ctx.fillText(line, cfg.x, y)
    } else {
      ctx.fillText(text, cfg.x, cfg.y, cfg.max_width)
    }
    ctx.restore()
  }

  drawTextField(f.product_name,     fields.name.value)
  drawTextField(f.product_subtitle, fields.subtitle.value)
  drawTextField(f.installments,     fields.installments.value)
  drawTextField(f.price,            fields.price.value)

  // Badge (centralizado no elemento circular do template)
  const badgeCfg = f.badge
  const badgeVal = fields.badge.value.trim()
  if (badgeCfg && badgeVal) {
    const text = badgeCfg.transform === 'uppercase' ? badgeVal.toUpperCase() : badgeVal
    ctx.save()
    ctx.font         = badgeCfg.font
    ctx.fillStyle    = badgeCfg.color
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, badgeCfg.cx, badgeCfg.cy, badgeCfg.max_width)
    ctx.restore()
  }
}

const debouncedRender = debounce(renderCanvas, 250)

// ── Template grid ─────────────────────────────────────────────────────────────

function buildTemplateGrid() {
  elTemplateGrid.innerHTML = ''

  for (const [id, tpl] of Object.entries(state.templateConfig)) {
    const isActive      = id === state.selectedTpl
    const isDisabled    = !!tpl.placeholder
    const isStory       = tpl.format === 'story'

    const wrap = document.createElement('div')
    wrap.className = [
      'tpl-item',
      isActive   ? 'tpl-item--active'   : '',
      isDisabled ? 'tpl-item--disabled' : '',
    ].join(' ').trim()
    wrap.dataset.id = id

    // Thumbnail canvas
    const thumbW = 120
    const thumbH = isStory ? 213 : 150
    const thumbWrap = document.createElement('div')
    thumbWrap.className = 'tpl-thumb-wrap'

    const thumb = document.createElement('canvas')
    thumb.className = 'tpl-thumb'
    thumb.width  = thumbW
    thumb.height = thumbH

    const tctx = thumb.getContext('2d')
    tctx.fillStyle = '#141414'
    tctx.fillRect(0, 0, thumbW, thumbH)

    if (!isDisabled) {
      loadImage(tpl.file).then(img => {
        tctx.drawImage(img, 0, 0, thumbW, thumbH)
      }).catch(() => {
        tctx.fillStyle = '#555'
        tctx.font = 'bold 14px sans-serif'
        tctx.textAlign = 'center'
        tctx.textBaseline = 'middle'
        tctx.fillText(id, thumbW / 2, thumbH / 2)
      })
    }

    thumbWrap.appendChild(thumb)

    // Meta row (badge + label)
    const meta = document.createElement('div')
    meta.className = 'tpl-meta'

    const badge = document.createElement('span')
    badge.className = `tpl-badge tpl-badge--${tpl.format}`
    badge.textContent = isStory ? 'Story' : 'Feed'

    const label = document.createElement('span')
    label.className = 'tpl-label'
    label.textContent = id

    meta.append(badge, label)
    wrap.append(thumbWrap, meta)

    if (isDisabled) {
      const soon = document.createElement('span')
      soon.className  = 'tpl-soon'
      soon.textContent = 'Em breve'
      wrap.appendChild(soon)
    } else {
      wrap.addEventListener('click', () => selectTemplate(id))
    }

    elTemplateGrid.appendChild(wrap)
  }
}

function selectTemplate(id) {
  state.selectedTpl = id
  document.querySelectorAll('.tpl-item').forEach(el => {
    el.classList.toggle('tpl-item--active', el.dataset.id === id)
  })
  renderCanvas()
}

// ── Main fetch flow ───────────────────────────────────────────────────────────

async function handleFetch() {
  hide(elErrorMsg, elWarningBg, elSectionFields, elSectionTemplates, elSectionPreview, elSectionDownload)
  state.ready = false
  state.productImgEl = null

  const rawUrl = elUrl.value.trim()
  show(elLoadingProduct)
  elBtnFetch.disabled = true

  // — Step 1: resolve canonical ML URL (handles meli.la short links)
  let mlUrl = rawUrl
  if (!/mercadolivre\.com/i.test(rawUrl)) {
    try {
      const res = await fetch(proxify(rawUrl))
      const finalUrl = res.headers.get('x-final-url') || ''
      if (/mercadolivre\.com\.br\/social\//i.test(finalUrl)) {
        hide(elLoadingProduct); elBtnFetch.disabled = false
        elErrorMsg.innerHTML =
          'Este link vai para uma página de loja, não um produto específico.<br>' +
          'Abra o link, clique em <strong>"Ir para produto"</strong> no produto desejado e cole o novo link aqui.'
        show(elErrorMsg); return
      }
      if (/mercadolivre\.com/i.test(finalUrl)) mlUrl = finalUrl
    } catch {}
  }

  if (!/mercadolivre\.com/i.test(mlUrl)) {
    hide(elLoadingProduct); elBtnFetch.disabled = false
    elErrorMsg.textContent = 'Link inválido. Use um link do Mercado Livre ou meli.la.'
    show(elErrorMsg); return
  }

  // — Step 2: extract item ID then fetch via Worker
  const itemId = extractItemId(rawUrl) || extractItemId(mlUrl)
  if (!itemId) {
    hide(elLoadingProduct); elBtnFetch.disabled = false
    elErrorMsg.textContent = 'Não foi possível identificar o produto. Cole o link direto do produto no Mercado Livre.'
    show(elErrorMsg); return
  }

  let product
  try {
    product = await fetchProduct(itemId, mlUrl)
  } catch (err) {
    hide(elLoadingProduct); elBtnFetch.disabled = false
    elErrorMsg.textContent = `Produto não encontrado (${err.message}). Verifique o link.`
    show(elErrorMsg); return
  }

  hide(elLoadingProduct)
  elBtnFetch.disabled = false
  state.product = product

  // — Step 2: populate fields
  const [name, subtitle] = splitTitle(product.title)
  fields.name.value         = name
  fields.subtitle.value     = subtitle
  fields.price.value        = formatPrice(product.price)
  fields.installments.value = formatInstallments(product.installments)
  fields.badge.value        = ''

  show(elSectionFields, elSectionTemplates)

  // — Step 3: remove background
  const imgUrl = product.pictures?.[0]?.url
  if (imgUrl) {
    elProgressBar.style.width   = '0%'
    elProgressLabel.textContent = 'Processando imagem… 0%'
    show(elLoadingBg)

    let processedUrl
    try {
      processedUrl        = await removeProductBackground(imgUrl)
    } catch {
      // Background removal failed — use proxied original so canvas isn't tainted
      processedUrl        = proxify(imgUrl)
      show(elWarningBg)
    }

    hide(elLoadingBg)

    // Load resulting image element for drawImage
    try {
      state.productImgEl = await loadImage(processedUrl)
    } catch {
      try {
        state.productImgEl = await loadImage(proxify(imgUrl))
      } catch {
        state.productImgEl = null
      }
    }
  }

  // — Step 4: render
  state.ready = true
  show(elSectionPreview, elSectionDownload)
  await renderCanvas()
}

// ── Download ──────────────────────────────────────────────────────────────────

elBtnDownload.addEventListener('click', () => {
  if (!state.ready) return
  elCanvas.toBlob(blob => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `arte_${state.selectedTpl}_${Date.now()}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  }, 'image/png')
})

// ── Event listeners ───────────────────────────────────────────────────────────

elBtnFetch.addEventListener('click', handleFetch)
elUrl.addEventListener('keydown', e => e.key === 'Enter' && handleFetch())

Object.values(fields).forEach(input => input.addEventListener('input', debouncedRender))

elIgHandle?.addEventListener('input', () => localStorage.setItem('ig_handle', elIgHandle.value))

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  try {
    const res = await fetch('templates/config.json')
    if (!res.ok) throw new Error()
    state.templateConfig = await res.json()
    buildTemplateGrid()
  } catch {
    console.error('Could not load templates/config.json')
  }

  const saved = localStorage.getItem('ig_handle')
  if (saved && elIgHandle) elIgHandle.value = saved

  // ── Bookmarklet: lê parâmetros da URL (?title=&price=&img=&inst=) ────────────
  const params = new URLSearchParams(location.search)
  const pTitle = params.get('title')
  const pPrice = params.get('price')
  const pImg   = params.get('img')
  const pInst  = params.get('inst')

  if (pTitle || pImg) {
    hide(elErrorMsg)

    if (pTitle) {
      const [name, subtitle] = splitTitle(pTitle)
      fields.name.value     = name
      fields.subtitle.value = subtitle
    }
    if (pPrice) {
      const num = parseFloat(pPrice)
      fields.price.value = isNaN(num) ? pPrice : formatPrice(num)
    }
    if (pInst) fields.installments.value = pInst
    fields.badge.value = ''

    show(elSectionFields, elSectionTemplates)

    if (pImg) {
      elProgressBar.style.width   = '0%'
      elProgressLabel.textContent = 'Processando imagem… 0%'
      show(elLoadingBg)

      // 1. Busca imagem via proxy → blob local (resolve CORS e qualquer formato)
      let srcBlob = null
      for (const proxyFn of PROXY_LIST) {
        try {
          const r = await fetch(proxyFn(pImg))
          if (r.ok) { srcBlob = await r.blob(); break }
        } catch {}
      }

      // 2. Se webp, converte para PNG via canvas offscreen (compatibilidade com bg-removal)
      if (srcBlob?.type?.includes('webp') || pImg.endsWith('.webp')) {
        try {
          const tmpUrl = URL.createObjectURL(srcBlob)
          const tmpImg = await new Promise((res, rej) => {
            const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = tmpUrl
          })
          URL.revokeObjectURL(tmpUrl)
          const tc = document.createElement('canvas')
          tc.width = tmpImg.naturalWidth; tc.height = tmpImg.naturalHeight
          tc.getContext('2d').drawImage(tmpImg, 0, 0)
          srcBlob = await new Promise(res => tc.toBlob(res, 'image/png'))
        } catch {}
      }

      // 3. Tenta remover fundo
      let finalUrl
      if (srcBlob) {
        try {
          const result = await removeBackground(srcBlob, {
            publicPath: IMGLY_PATH,
            progress: (_k, cur, tot) => {
              if (tot <= 0) return
              const pct = Math.round((cur / tot) * 100)
              elProgressBar.style.width = `${pct}%`
              elProgressLabel.textContent = `Processando imagem… ${pct}%`
            }
          })
          finalUrl = URL.createObjectURL(result)
        } catch {
          // @imgly falhou → tenta remoção local por flood-fill de fundo branco
          try {
            elProgressLabel.textContent = 'Removendo fundo… (modo local)'
            const result = await removeWhiteBackground(srcBlob)
            finalUrl = URL.createObjectURL(result)
          } catch {
            finalUrl = URL.createObjectURL(srcBlob)
            show(elWarningBg)
          }
        }
      } else {
        finalUrl = proxify(pImg)
        show(elWarningBg)
      }

      hide(elLoadingBg)

      // 4. Carrega imagem — blob URLs são same-origin, não poluem o canvas
      try {
        state.productImgEl = await new Promise((res, rej) => {
          const img = new Image()
          img.onload = () => res(img)
          img.onerror = rej
          img.src = finalUrl
        })
      } catch { state.productImgEl = null }
    }

    state.ready = true
    show(elSectionPreview, elSectionDownload)
    await renderCanvas()
  }
}

init()
