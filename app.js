// ── Constants ────────────────────────────────────────────────────────────────

const CORS_PROXY    = 'https://corsproxy.io/?'
const WORKER_URL    = 'https://spring-night-4416.danielspsg.workers.dev'

// Elementos arrastáveis/selecionáveis (ordem = de baixo p/ cima no desenho)
const DRAGGABLE_KEYS = ['product', 'product_name', 'product_subtitle', 'installments', 'price', 'badge']

function freshTransforms() {
  return {
    product:          { dx: 0, dy: 0, scale: 1 },
    product_name:     { dx: 0, dy: 0, scale: 1 },
    product_subtitle: { dx: 0, dy: 0, scale: 1 },
    installments:     { dx: 0, dy: 0, scale: 1 },
    price:            { dx: 0, dy: 0, scale: 1 },
    badge:            { dx: 0, dy: 0, scale: 1 },
  }
}

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  product:         null,
  productImgEl:    null,   // HTMLImageElement ready for drawImage
  templateConfig:  null,
  selectedTpl:     'T1',
  ready:           false,
  tplImg:          null,   // cached template image for the current render
  hitboxes:        [],     // [{ key, x, y, w, h }] em px do canvas, p/ hit-testing
  selected:        null,   // chave do elemento selecionado (DRAGGABLE_KEYS)
  transforms:      freshTransforms(), // deslocamento/escala manual por elemento
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
const elSizeSlider      = $('size-slider')
const elBtnResetPos     = $('btn-reset-pos')
const elSelLabel        = $('sel-label')

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

// Baixa a imagem do produto como blob PNG, com CORS resolvido.
// images.weserv.nl é um proxy de imagem dedicado: manda Access-Control-Allow-Origin,
// é estável e converte qualquer formato (inclusive webp) para PNG com &output=png.
async function fetchImageBlob(url) {
  const weserv = 'https://images.weserv.nl/?url=' +
    encodeURIComponent(url.replace(/^https?:\/\//, '')) + '&output=png'
  try {
    const r = await fetch(weserv)
    if (r.ok) {
      const b = await r.blob()
      if (b && b.size > 0) return b
    }
  } catch {}

  // Reserva: proxies genéricos (menos confiáveis, mas servem de rede de segurança)
  for (const proxyFn of PROXY_LIST) {
    try {
      const r = await fetch(proxyFn(url))
      if (r.ok) { const b = await r.blob(); if (b?.size > 0) return b }
    } catch {}
  }
  return null
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

  // Considera pixel "fundo": já transparente, OU claro e quase-acromático
  // (branco/cinza). A checagem (max-min) pequena evita comer cores vivas do produto.
  const isLight = idx => {
    const base = idx * 4
    if (data[base + 3] < 20) return true
    const r = data[base], g = data[base + 1], b = data[base + 2]
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    return mn >= 232 && (mx - mn) <= 22
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

// Carrega o @imgly sob demanda. Importante: usamos esm.sh, que resolve a árvore
// de dependências (onnxruntime-web etc.) — o build do jsDelivr não resolve esses
// imports "bare" no navegador, e era por isso que a remoção por IA nunca funcionava.
let _removeBgFn = null
async function getRemoveBg() {
  if (_removeBgFn) return _removeBgFn
  const mod = await import('https://esm.sh/@imgly/background-removal@1.7.0')
  _removeBgFn = mod.removeBackground
  return _removeBgFn
}

// Recebe o blob original e devolve { blob, removed, method }.
// 1º) IA (@imgly): entende produto vs fundo — não come detalhes brancos do produto.
// 2º) flood-fill: reserva confiável para fotos de fundo branco.
async function processProductImage(blob) {
  try {
    elProgressLabel.textContent = 'Carregando IA de recorte…'
    const removeBackground = await getRemoveBg()
    // Sem publicPath: usa o CDN de modelos padrão da lib (resolvido pelo esm.sh)
    const out = await removeBackground(blob, {
      progress: (key, current, total) => {
        if (total <= 0) return
        const pct = Math.round((current / total) * 100)
        elProgressBar.style.width = `${pct}%`
        const stage = /fetch/i.test(key) ? 'Baixando modelo de IA' : 'Removendo fundo com IA'
        elProgressLabel.textContent = `${stage}… ${pct}%`
      },
    })
    if (out && out.size > 0) return { blob: out, removed: true, method: 'ai' }
  } catch {}

  // IA indisponível → flood-fill de fundo branco
  try {
    elProgressLabel.textContent = 'Removendo fundo…'
    const out = await removeWhiteBackground(blob)
    if (out && out.size > 0) return { blob: out, removed: true, method: 'floodfill' }
  } catch {}

  return { blob, removed: false }
}

// ── Canvas rendering ──────────────────────────────────────────────────────────

const tplCache = new Map()

async function getTemplateImg(file) {
  if (tplCache.has(file)) return tplCache.get(file)
  try {
    const img = await loadImage(file)
    tplCache.set(file, img)
    return img
  } catch {
    tplCache.set(file, null)
    return null
  }
}

// Carrega o template (cacheado) + fontes e então desenha. Use para o render "completo".
async function renderCanvas() {
  if (!state.ready || !state.templateConfig) return
  const tpl = state.templateConfig[state.selectedTpl]
  if (!tpl || tpl.placeholder) return
  await document.fonts.ready
  state.tplImg = await getTemplateImg(tpl.file)
  drawScene()
}

// Escala o tamanho de fonte dentro de uma string de fonte CSS ("bold 52px Impact")
function scaleFont(font, scale) {
  return font.replace(/(\d+(?:\.\d+)?)px/, (_m, n) => `${parseFloat(n) * scale}px`)
}

// Desenha um campo de texto aplicando o transform manual e devolve a bounding box.
function drawTextField(ctx, cfg, raw, t) {
  if (!cfg || !raw) return null
  const text  = cfg.transform === 'uppercase' ? raw.toUpperCase() : raw
  const scale = t?.scale || 1
  const x = cfg.x + (t?.dx || 0)
  const y = cfg.y + (t?.dy || 0)
  const align = cfg.align || 'left'

  ctx.save()
  ctx.font         = scaleFont(cfg.font, scale)
  ctx.fillStyle    = cfg.color
  ctx.textAlign    = align
  ctx.textBaseline = 'alphabetic'

  const fontSize = parseFloat(cfg.font.match(/(\d+(?:\.\d+)?)px/)?.[1] || '16') * scale

  let maxLineW = 0, lines = 1
  if (cfg.wrap) {
    const lineHeight = (cfg.line_height || Math.round(parseFloat(cfg.font.match(/(\d+(?:\.\d+)?)px/)?.[1] || '16') * 1.25)) * scale
    const maxW = (cfg.max_width || 9999) * scale
    const words = text.split(' ')
    let line = '', cy = y
    lines = 0
    for (const word of words) {
      const test = line ? `${line} ${word}` : word
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, x, cy); maxLineW = Math.max(maxLineW, ctx.measureText(line).width)
        line = word; cy += lineHeight; lines++
      } else { line = test }
    }
    if (line) { ctx.fillText(line, x, cy); maxLineW = Math.max(maxLineW, ctx.measureText(line).width); lines++ }
    var boxH = (lines - 1) * lineHeight + fontSize * 1.2
  } else {
    ctx.fillText(text, x, y, cfg.max_width ? cfg.max_width * scale : undefined)
    maxLineW = ctx.measureText(text).width
    if (cfg.max_width) maxLineW = Math.min(maxLineW, cfg.max_width * scale)
    var boxH = fontSize * 1.2
  }
  ctx.restore()

  // bounding box (canto superior esquerdo), ajustada pelo alinhamento
  let bx = x
  if (align === 'center') bx = x - maxLineW / 2
  else if (align === 'right') bx = x - maxLineW
  return { x: bx, y: y - fontSize, w: maxLineW, h: boxH }
}

// Desenho síncrono — chamado a cada frame do arraste, então precisa ser rápido
// (usa o template já cacheado em state.tplImg).
function drawScene() {
  const tpl = state.templateConfig?.[state.selectedTpl]
  if (!tpl || tpl.placeholder) return

  const { w, h } = tpl.dimensions
  if (elCanvas.width  !== w) elCanvas.width  = w
  if (elCanvas.height !== h) elCanvas.height = h

  const ctx = elCanvas.getContext('2d')
  ctx.clearRect(0, 0, w, h)
  const hits = []

  // 1. Template
  if (state.tplImg) {
    ctx.drawImage(state.tplImg, 0, 0, w, h)
  } else {
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#555'; ctx.font = 'bold 48px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(`Template ${state.selectedTpl}`, w / 2, h / 2)
  }

  const f = tpl.fields
  const T = state.transforms

  // 2. Produto — auto-encaixe na zona + transform manual (arraste/tamanho)
  if (state.productImgEl) {
    const z   = tpl.product_zone
    const img = state.productImgEl
    const baseScale = Math.min(z.w / img.width, z.h / img.height)
    const t   = T.product
    const drawW = img.width  * baseScale * t.scale
    const drawH = img.height * baseScale * t.scale
    const cx = z.x + z.w / 2 + t.dx        // centro da zona + deslocamento manual
    const cy = z.y + z.h / 2 + t.dy
    const drawX = cx - drawW / 2
    const drawY = cy - drawH / 2
    ctx.drawImage(img, drawX, drawY, drawW, drawH)
    hits.push({ key: 'product', x: drawX, y: drawY, w: drawW, h: drawH })
  }

  // 3. Campos de texto (sempre por cima do produto)
  const textMap = [
    ['product_name',     f.product_name,     fields.name.value],
    ['product_subtitle', f.product_subtitle, fields.subtitle.value],
    ['installments',     f.installments,     fields.installments.value],
    ['price',            f.price,            fields.price.value],
  ]
  for (const [key, cfg, val] of textMap) {
    const box = drawTextField(ctx, cfg, val, T[key])
    if (box) hits.push({ key, ...box })
  }

  // 4. Badge (centralizado no elemento circular do template)
  const badgeCfg = f.badge
  const badgeVal = fields.badge.value.trim()
  if (badgeCfg && badgeVal) {
    const t = T.badge
    const scale = t.scale || 1
    const text = badgeCfg.transform === 'uppercase' ? badgeVal.toUpperCase() : badgeVal
    const bx = badgeCfg.cx + t.dx, by = badgeCfg.cy + t.dy
    ctx.save()
    ctx.font         = scaleFont(badgeCfg.font, scale)
    ctx.fillStyle    = badgeCfg.color
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, bx, by, badgeCfg.max_width)
    const bw = Math.min(ctx.measureText(text).width, badgeCfg.max_width || 9999)
    const bh = parseFloat(badgeCfg.font.match(/(\d+(?:\.\d+)?)px/)?.[1] || '16') * scale * 1.2
    ctx.restore()
    hits.push({ key: 'badge', x: bx - bw / 2, y: by - bh / 2, w: bw, h: bh })
  }

  state.hitboxes = hits

  // 5. Contorno do elemento selecionado (não entra no PNG final — redesenhado p/ download)
  if (state.selected) {
    const box = hits.find(b => b.key === state.selected)
    if (box) {
      const pad = 8
      ctx.save()
      ctx.strokeStyle = '#f97316'
      ctx.lineWidth = Math.max(2, w / 400)
      ctx.setLineDash([12, 8])
      ctx.strokeRect(box.x - pad, box.y - pad, box.w + pad * 2, box.h + pad * 2)
      ctx.restore()
    }
  }
}

function resetTransform() {
  state.transforms = freshTransforms()
  state.selected = null
  if (elSizeSlider) { elSizeSlider.value = '1'; elSizeSlider.disabled = true }
  syncSelectionUI()
}

// Atualiza o rótulo/slider conforme o elemento selecionado
function syncSelectionUI() {
  const labels = {
    product: 'Produto', product_name: 'Nome', product_subtitle: 'Subtítulo',
    installments: 'Parcelas', price: 'Preço', badge: 'Selo',
  }
  if (elSelLabel) {
    elSelLabel.textContent = state.selected
      ? `Selecionado: ${labels[state.selected] || state.selected}`
      : 'Toque num elemento para selecionar'
  }
  if (elSizeSlider) {
    elSizeSlider.disabled = !state.selected
    if (state.selected) elSizeSlider.value = String(state.transforms[state.selected].scale)
  }
}

// Os campos de texto só mudam o desenho — não precisam recarregar template/fontes
const debouncedRender = debounce(() => drawScene(), 150)

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
  resetTransform()   // a zona muda entre templates → recomeça centralizado
  renderCanvas()
}

// ── Main fetch flow ───────────────────────────────────────────────────────────

async function handleFetch() {
  hide(elErrorMsg, elWarningBg, elSectionFields, elSectionTemplates, elSectionPreview, elSectionDownload)
  state.ready = false
  state.productImgEl = null
  resetTransform()

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

  // — Step 3: baixa imagem (weserv → blob PNG) e remove fundo branco
  const imgUrl = product.pictures?.[0]?.url
  if (imgUrl) {
    elProgressBar.style.width   = '100%'
    elProgressLabel.textContent = 'Baixando imagem…'
    show(elLoadingBg)

    const srcBlob = await fetchImageBlob(imgUrl)
    let finalBlob = srcBlob
    if (srcBlob) {
      elProgressLabel.textContent = 'Removendo fundo…'
      const { blob, removed } = await processProductImage(srcBlob)
      finalBlob = blob
      if (!removed) show(elWarningBg)
    } else {
      show(elWarningBg)
    }

    hide(elLoadingBg)

    const finalUrl = finalBlob ? URL.createObjectURL(finalBlob) : proxify(imgUrl)
    try {
      state.productImgEl = await loadImage(finalUrl)
    } catch {
      state.productImgEl = null
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
  // Redesenha sem o contorno de seleção para não sair no PNG final
  const keepSel = state.selected
  state.selected = null
  drawScene()
  elCanvas.toBlob(blob => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `arte_${state.selectedTpl}_${Date.now()}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    state.selected = keepSel
    drawScene()
  }, 'image/png')
})

// ── Event listeners ───────────────────────────────────────────────────────────

elBtnFetch.addEventListener('click', handleFetch)
elUrl.addEventListener('keydown', e => e.key === 'Enter' && handleFetch())

Object.values(fields).forEach(input => input.addEventListener('input', debouncedRender))

elIgHandle?.addEventListener('input', () => localStorage.setItem('ig_handle', elIgHandle.value))

// ── Editor interativo: selecionar / arrastar / redimensionar elementos ─────────

// Converte coordenadas do ponteiro (CSS px na tela) para coordenadas do canvas (px reais)
function canvasCoords(e) {
  const rect = elCanvas.getBoundingClientRect()
  return {
    x: (e.clientX - rect.left) * (elCanvas.width  / rect.width),
    y: (e.clientY - rect.top)  * (elCanvas.height / rect.height),
  }
}

// Acha o elemento sob o ponto — itera de cima para baixo (texto vence o produto)
function hitTest(p) {
  const pad = 6
  for (let i = state.hitboxes.length - 1; i >= 0; i--) {
    const b = state.hitboxes[i]
    if (p.x >= b.x - pad && p.x <= b.x + b.w + pad &&
        p.y >= b.y - pad && p.y <= b.y + b.h + pad) return b.key
  }
  return null
}

let dragging  = false
let dragStart = null   // { x, y, dx0, dy0, key }

elCanvas.addEventListener('pointerdown', e => {
  if (!state.ready) return
  const p   = canvasCoords(e)
  const key = hitTest(p)

  state.selected = key
  syncSelectionUI()

  if (!key) { drawScene(); return }   // clicou no vazio → só deseleciona

  const t = state.transforms[key]
  dragging  = true
  dragStart = { x: p.x, y: p.y, dx0: t.dx, dy0: t.dy, key }
  try { elCanvas.setPointerCapture(e.pointerId) } catch {}
  elCanvas.style.cursor = 'grabbing'
  drawScene()
  e.preventDefault()
})

elCanvas.addEventListener('pointermove', e => {
  if (!dragging) {
    elCanvas.style.cursor = hitTest(canvasCoords(e)) ? 'grab' : 'default'
    return
  }
  const p = canvasCoords(e)
  const t = state.transforms[dragStart.key]
  t.dx = dragStart.dx0 + (p.x - dragStart.x)
  t.dy = dragStart.dy0 + (p.y - dragStart.y)
  drawScene()
  e.preventDefault()
})

function endDrag(e) {
  if (!dragging) return
  dragging = false
  elCanvas.style.cursor = 'grab'
  try { elCanvas.releasePointerCapture(e.pointerId) } catch {}
}
elCanvas.addEventListener('pointerup', endDrag)
elCanvas.addEventListener('pointercancel', endDrag)

// Slider de tamanho — afeta o elemento selecionado
elSizeSlider?.addEventListener('input', () => {
  if (!state.selected) return
  state.transforms[state.selected].scale = parseFloat(elSizeSlider.value)
  drawScene()
})

// Resetar posições e tamanhos
elBtnResetPos?.addEventListener('click', () => {
  resetTransform()
  drawScene()
})

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
      elProgressBar.style.width   = '100%'
      elProgressLabel.textContent = 'Baixando imagem…'
      show(elLoadingBg)

      // 1. Baixa via weserv → blob PNG (CORS resolvido, webp convertido)
      const srcBlob = await fetchImageBlob(pImg)

      // 2. Remove o fundo branco por flood-fill
      let finalBlob = srcBlob
      if (srcBlob) {
        elProgressLabel.textContent = 'Removendo fundo…'
        const { blob, removed } = await processProductImage(srcBlob)
        finalBlob = blob
        if (!removed) show(elWarningBg)
      } else {
        show(elWarningBg)
      }

      hide(elLoadingBg)

      // 3. Carrega imagem — blob URLs são same-origin, não poluem o canvas
      const finalUrl = finalBlob ? URL.createObjectURL(finalBlob) : proxify(pImg)
      try {
        state.productImgEl = await loadImage(finalUrl)
      } catch { state.productImgEl = null }
    }

    state.ready = true
    show(elSectionPreview, elSectionDownload)
    await renderCanvas()
  }
}

init()
