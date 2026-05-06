# Gerador de Arte — Depósito do Nô

Ferramenta 100% client-side para gerar artes de afiliado a partir de produtos do Mercado Livre.
Sem backend, sem login, sem custo.

---

## Deploy no GitHub Pages

1. Crie um repositório no GitHub (ex: `gerador-arte`)
2. Faça upload de todos os arquivos, incluindo a pasta `templates/`
3. Vá em **Settings → Pages → Source: main branch / root**
4. Aguarde ~1 minuto e acesse: `https://[usuario].github.io/gerador-arte`

> Os templates PNG precisam estar em `templates/T1.png` … `templates/T7.png` no repositório.

---

## Como usar

1. Cole o link de um produto do Mercado Livre
2. Clique em **Buscar**
3. Aguarde a remoção automática do fundo (primeira vez: ~40 MB de modelo baixado, fica em cache)
4. Edite os campos se necessário
5. Escolha o template
6. Clique em **Baixar PNG**

---

## Adicionar/substituir templates

Coloque os arquivos PNG em `templates/` com os nomes exatos:

```
templates/T1.png   (Feed 1080×1350)
templates/T2.png   (Feed 1080×1350)
templates/T3.png   (Feed 1080×1350)
templates/T4.png   (Feed 1080×1350)
templates/T5.png   (Story 1080×1920)
templates/T6.png   (Story 1080×1920)
templates/T7.png   (Story 1080×1920)
```

---

## Calibrar coordenadas de um template novo

As coordenadas definem onde o Canvas renderiza cada texto e a imagem do produto.
O processo de calibração usa duas versões do PNG: uma vazia e uma preenchida.

### Passo a passo

1. Abra o PNG no **Figma, Photoshop ou GIMP**
2. Ative a régua (pixels) com origem no canto **superior esquerdo**
3. Para cada campo de texto, anote:
   - `x`, `y` — posição do início do texto (baseline)
   - `max_width` — largura máxima disponível
4. Para a zona do produto, anote:
   - `x`, `y` — canto superior esquerdo da área
   - `w`, `h` — largura e altura da área
5. Para o badge circular, anote:
   - `cx`, `cy` — centro do círculo
6. Edite `templates/config.json`, removendo `"placeholder": true` e preenchendo os campos

### Estrutura de um template no config.json

```json
"T2": {
  "format": "feed",
  "file": "templates/T2.png",
  "dimensions": { "w": 1080, "h": 1350 },

  "product_zone": {
    "x": 400,
    "y": 435,
    "w": 643,
    "h": 687
  },

  "fields": {
    "product_name": {
      "x": 374, "y": 760,
      "font": "bold 52px Impact",
      "color": "#FFFFFF",
      "align": "left",
      "max_width": 620,
      "transform": "uppercase"
    },
    "product_subtitle": {
      "x": 374, "y": 870,
      "font": "28px Impact",
      "color": "#FFC107",
      "align": "left",
      "max_width": 620,
      "transform": "uppercase"
    },
    "installments": {
      "x": 374, "y": 960,
      "font": "bold 30px Impact",
      "color": "#FFFFFF",
      "align": "left",
      "max_width": 620,
      "transform": "uppercase"
    },
    "price": {
      "x": 374, "y": 1055,
      "font": "bold 72px Impact",
      "color": "#FFD700",
      "align": "left",
      "max_width": 620
    },
    "badge": {
      "cx": 858, "cy": 455,
      "font": "bold 44px Impact",
      "color": "#8B0000",
      "align": "center",
      "optional": true,
      "transform": "uppercase"
    }
  }
}
```

### Referência dos campos

| Campo | Tipo | Descrição |
|---|---|---|
| `format` | `"feed"` / `"story"` | Formato do template |
| `dimensions.w/h` | número | Dimensões em pixels |
| `product_zone.x/y/w/h` | número | Área da imagem do produto |
| `fields.*.x/y` | número | Posição baseline do texto |
| `fields.*.font` | string | Fonte Canvas: `"bold 52px Impact"` |
| `fields.*.color` | string | Cor hexadecimal |
| `fields.*.max_width` | número | Largura máxima em px (texto é escalado) |
| `fields.*.transform` | `"uppercase"` | Converte texto para maiúsculas |
| `fields.badge.cx/cy` | número | Centro do círculo do badge |
| `placeholder` | boolean | Se `true`, template aparece desabilitado no seletor |

---

## Limitações conhecidas

| Limitação | Solução adotada |
|---|---|
| CORS nas imagens do ML | Proxy via `corsproxy.io` |
| Modelo ONNX ~40MB na 1ª vez | Progress bar + cache automático do browser |
| Fundo complexo | Aviso amarelo, usa imagem original |
| Fontes no Canvas | `document.fonts.ready` antes de renderizar |

---

## Stack

- HTML5 + CSS3 + JavaScript ES6+ (vanilla, sem build)
- [`@imgly/background-removal`](https://github.com/imgly/background-removal-js) via CDN (WASM)
- Canvas API nativa
- API pública do Mercado Livre
- Deploy: GitHub Pages
