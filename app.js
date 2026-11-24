import { generateImage } from './apiyi.js'

const select = selector => document.querySelector(selector)
const localApi = select('meta[name="pawfit-api-mode"]').content === 'local'

const form = select('#try-on-form')
const generateButton = select('#generate')
const generateLabel = select('#generate-label')
const formError = select('#form-error')
const settings = select('#settings-dialog')
const openSettings = select('#open-settings')
const keyInput = select('#api-key')
const keyError = select('#key-error')
const rememberKey = select('#remember-key')
const toggleKey = select('#toggle-key')
const clearKey = select('#clear-key')
const resultFrame = select('#result-frame')
const resultImage = select('#result-image')
const exampleLabel = select('#example-label')
const loading = select('#loading-overlay')
const resultStatus = select('#result-status')
const download = select('#download-image')

const example = { src: resultImage.src, alt: resultImage.alt }
const maxFileBytes = 10 * 1024 * 1024
const imageType = /^image\/(jpeg|png|webp)$/i
const imageExtension = /\.(jpe?g|png|webp)$/i
const keyPattern = /^[\x21-\x7e]{1,4096}$/
const keyStorage = 'pawfit-studio:api-key'
const uploads = Array.from(form.querySelectorAll('[data-upload]'), field => {
  const dropzone = field.querySelector('.dropzone')
  const hint = field.querySelector('.file-hint')
  return {
    name: field.dataset.upload,
    title: field.querySelector('h3').textContent,
    input: field.querySelector('input'),
    dropzone,
    remove: field.querySelector('.remove-file'),
    icon: field.querySelector('.slot-icon'),
    thumbnail: field.querySelector('.thumbnail'),
    action: field.querySelector('.file-action'),
    hint,
    initialHint: hint.textContent,
    error: field.querySelector('.field-error'),
    file: null,
    preview: '',
    revision: 0,
    pending: false,
  }
})

let apiKey = readSavedKey()
let keyIsSaved = Boolean(apiKey)
let busy = false
let resultUrl = ''

function readSavedKey() {
  try {
    const value = localStorage.getItem(keyStorage) ?? ''
    return keyPattern.test(value) ? value : ''
  } catch {
    return ''
  }
}

function setError(element, text = '', control) {
  element.textContent = text
  element.hidden = !text
  if (control) {
    if (text) control.setAttribute('aria-invalid', 'true')
    else control.removeAttribute('aria-invalid')
  }
}

function updateDownload() {
  if (resultUrl && !busy) {
    download.href = resultUrl
    download.removeAttribute('aria-disabled')
  } else {
    download.removeAttribute('href')
    download.setAttribute('aria-disabled', 'true')
  }
}

function clearResult() {
  if (!resultUrl) return

  URL.revokeObjectURL(resultUrl)
  resultUrl = ''
  resultImage.src = example.src
  resultImage.alt = example.alt
  exampleLabel.hidden = false
  resultFrame.classList.remove('has-result')
  resultStatus.textContent = '生成后可预览并下载试穿图'
  updateDownload()
}

function renderUpload(upload) {
  const hasFile = Boolean(upload.file)
  upload.dropzone.classList.toggle('has-file', hasFile)
  upload.remove.hidden = !hasFile
  upload.icon.hidden = hasFile
  upload.thumbnail.hidden = !hasFile

  if (hasFile) {
    upload.thumbnail.src = upload.preview
    upload.action.textContent = upload.file.name
    upload.action.title = upload.file.name
    upload.hint.textContent = '点击替换图片'
  } else {
    upload.thumbnail.removeAttribute('src')
    upload.action.textContent = '点击上传或拖入图片'
    upload.action.removeAttribute('title')
    upload.hint.textContent = upload.initialHint
  }
}

function validateFile(file) {
  if (!imageType.test(file.type) && !(imageExtension.test(file.name) && (!file.type || file.type === 'application/octet-stream'))) {
    return '请选择 JPG、PNG 或 WebP 图片。'
  }
  if (file.size > maxFileBytes) return '每张图片不能超过 10 MB。'
  if (!file.size) return '这张图片是空文件，请重新选择。'
  return ''
}

function updateGenerateButton() {
  generateButton.disabled = busy || uploads.some(upload => upload.pending)
}

async function loadImage(url) {
  const image = new Image()
  image.src = url
  await image.decode()
}

async function selectFiles(upload, files) {
  if (busy || !files.length) return

  const revision = ++upload.revision
  const file = files[0]
  const error = files.length > 1 ? '每个位置只能选择一张图片。' : validateFile(file)
  setError(formError)
  setError(upload.error, error, upload.dropzone)

  upload.pending = !error
  updateGenerateButton()
  if (error) return

  const url = URL.createObjectURL(file)
  try {
    await loadImage(url)
    if (upload.revision !== revision) {
      URL.revokeObjectURL(url)
      return
    }

    if (upload.preview) URL.revokeObjectURL(upload.preview)
    upload.file = file
    upload.preview = url
    renderUpload(upload)
    clearResult()
  } catch {
    URL.revokeObjectURL(url)
    if (upload.revision === revision) {
      setError(upload.error, '无法打开这张图片，请重新选择。', upload.dropzone)
    }
  } finally {
    if (upload.revision === revision) {
      upload.pending = false
      updateGenerateButton()
    }
  }
}

for (const upload of uploads) {
  upload.dropzone.addEventListener('click', () => upload.input.click())
  upload.input.addEventListener('change', () => {
    selectFiles(upload, upload.input.files)
    upload.input.value = ''
  })
  upload.remove.addEventListener('click', () => {
    ++upload.revision
    upload.pending = false
    URL.revokeObjectURL(upload.preview)
    upload.file = null
    upload.preview = ''
    setError(upload.error, '', upload.dropzone)
    setError(formError)
    renderUpload(upload)
    clearResult()
    updateGenerateButton()
    upload.dropzone.focus()
  })

  upload.dropzone.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('Files')) return

    event.preventDefault()
    event.dataTransfer.dropEffect = busy ? 'none' : 'copy'
    if (!busy) upload.dropzone.classList.add('is-dragging')
  })
  upload.dropzone.addEventListener('dragleave', event => {
    if (!upload.dropzone.contains(event.relatedTarget)) upload.dropzone.classList.remove('is-dragging')
  })
  upload.dropzone.addEventListener('drop', event => {
    event.preventDefault()
    upload.dropzone.classList.remove('is-dragging')
    selectFiles(upload, event.dataTransfer.files)
  })
}

// Keep a file dropped outside an upload area from replacing the app tab.
for (const eventName of ['dragover', 'drop']) {
  document.addEventListener(eventName, event => {
    if (event.dataTransfer.types.includes('Files')) event.preventDefault()
  })
}

function setKeyVisibility(visible) {
  keyInput.type = visible ? 'text' : 'password'
  toggleKey.setAttribute('aria-pressed', String(visible))
  toggleKey.setAttribute('aria-label', visible ? '隐藏密钥' : '显示密钥')
  toggleKey.querySelector('.icon').textContent = visible ? 'visibility_off' : 'visibility'
}

function updateKeyStatus() {
  openSettings.classList.toggle('is-configured', Boolean(apiKey))
  openSettings.querySelector('.icon').textContent = apiKey ? 'check_circle' : 'settings'
  openSettings.setAttribute('aria-label', apiKey ? 'API 设置，已配置密钥' : 'API 设置')
}

function showSettings() {
  keyInput.value = apiKey
  rememberKey.checked = keyIsSaved
  setKeyVisibility(false)
  setError(keyError, '', keyInput)
  clearKey.hidden = !apiKey
  settings.showModal()
}

openSettings.addEventListener('click', showSettings)
select('#close-settings').addEventListener('click', () => settings.close())
toggleKey.addEventListener('click', () => setKeyVisibility(keyInput.type === 'password'))
keyInput.addEventListener('input', () => setError(keyError, '', keyInput))
rememberKey.addEventListener('change', () => setError(keyError, '', keyInput))

select('#settings-form').addEventListener('submit', event => {
  event.preventDefault()
  const value = keyInput.value.trim()
  if (!keyPattern.test(value)) {
    setError(keyError, '请输入 API 易令牌。令牌中不能有空格。', keyInput)
    keyInput.focus()
    return
  }

  try {
    if (rememberKey.checked) localStorage.setItem(keyStorage, value)
    else if (keyIsSaved) localStorage.removeItem(keyStorage)
  } catch {
    setError(keyError, rememberKey.checked
      ? '浏览器无法记住密钥。取消勾选后，可在当前页面使用。'
      : '浏览器无法移除已记住的密钥，请检查网站存储设置。')
    return
  }

  apiKey = value
  keyIsSaved = rememberKey.checked
  updateKeyStatus()
  setError(formError)
  settings.close()
})

clearKey.addEventListener('click', () => {
  try {
    if (keyIsSaved) localStorage.removeItem(keyStorage)
  } catch {
    setError(keyError, '浏览器无法清除已记住的密钥，请检查网站存储设置。')
    return
  }
  apiKey = ''
  keyIsSaved = false
  updateKeyStatus()
  settings.close()
})

settings.addEventListener('close', () => {
  keyInput.value = ''
  setKeyVisibility(false)
})

updateKeyStatus()

function setBusy(value) {
  busy = value
  updateGenerateButton()
  generateLabel.textContent = busy ? '正在生成…' : '生成试穿图'
  openSettings.disabled = busy
  loading.hidden = !busy
  resultImage.setAttribute('aria-busy', String(busy))
  for (const upload of uploads) {
    upload.dropzone.disabled = busy
    upload.remove.disabled = busy
  }
  updateDownload()
}

async function requestLocalImage() {
  const data = new FormData()
  data.append('apiKey', apiKey)
  for (const upload of uploads) data.append(upload.name, upload.file)

  const response = await fetch('/api/try-on', { method: 'POST', body: data })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(payload?.error || '生成失败，请稍后再试。')
  }
  return response.blob()
}

async function requestTryOn() {
  const image = localApi
    ? await requestLocalImage()
    : await generateImage(apiKey, uploads[0].file, uploads[1].file)
  if (!image.size || image.type !== 'image/png') throw new Error('未收到可预览的试穿图。')
  return URL.createObjectURL(image)
}

form.addEventListener('submit', async event => {
  event.preventDefault()
  if (busy || uploads.some(upload => upload.pending)) return

  setError(formError)
  const missing = uploads.filter(upload => !upload.file)
  if (missing.length) {
    for (const upload of missing) setError(upload.error, `请先上传${upload.title}。`, upload.dropzone)
    missing[0].dropzone.focus()
    return
  }
  if (!apiKey) {
    showSettings()
    return
  }

  for (const upload of uploads) setError(upload.error, '', upload.dropzone)
  setBusy(true)
  resultStatus.textContent = '正在等待 API 易生成图片'
  try {
    const nextUrl = await requestTryOn()
    try {
      await loadImage(nextUrl)
    } catch {
      URL.revokeObjectURL(nextUrl)
      throw new Error('生成图片无法打开，请重试。')
    }
    if (resultUrl) URL.revokeObjectURL(resultUrl)
    resultUrl = nextUrl
    resultImage.src = resultUrl
    resultImage.alt = '狗狗穿上参考服装的生成图片'
    exampleLabel.hidden = true
    resultFrame.classList.add('has-result')
    resultStatus.textContent = '试穿图已生成'
    if (resultFrame.getBoundingClientRect().top >= window.innerHeight) {
      resultFrame.scrollIntoView({ block: 'nearest' })
    }
  } catch (error) {
    const connectionError = localApi ? '无法连接本地服务，请确认网站仍在运行后重试。' : '无法连接 API 易，请检查网络后重试。'
    const message = error instanceof TypeError ? connectionError : error.message
    setError(formError, message)
    resultStatus.textContent = '生成失败，可检查提示后重试'
  } finally {
    setBusy(false)
  }
})
