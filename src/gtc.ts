import Jimp from 'jimp'
import EventEmitter from 'events'
// @ts-ignore
import qrReader from 'qrcode-reader'
import qrPrint from 'qrcode-terminal'
import { CookieJar } from 'tough-cookie'
import axios, { AxiosInstance } from 'axios'
import randomUseragent from 'random-useragent'
import { wrapper } from 'axios-cookiejar-support'
import { CountryCode, GtcOptions } from '../types/gtc'
import { FileCookieStore } from 'tough-cookie-file-store'

class Gtc extends EventEmitter {
  #base_url = 'https://web.getcontact.com'
  #options: GtcOptions
  #hash?: string | null
  #client: AxiosInstance
  #qr: typeof qrReader
  #isLogged: boolean = false

  constructor(options: GtcOptions) {
    super()

    const store = options.cookiePath ? new FileCookieStore(options.cookiePath) : undefined
    const jar = new CookieJar(store)

    this.#options = options
    this.#client = wrapper(
      axios.create({
        jar,
        headers: { 'User-Agent': randomUseragent.getRandom((ua) => ua.browserName === 'Safari') },
      })
    )
    this.#qr = new qrReader()
  }

  async #getHash() {
    const result = await this.#client.get(this.#base_url).then((res) => res.data)
    const before = result.match(/hash: '([a-fA-F0-9]+)'/)
    const after = result.match(/<input type="hidden" name="hash" value="([^"]+)"\/>/)

    if (before) {
      this.#isLogged = false
      this.#hash = before[1] || null
    }

    if (after) {
      this.#isLogged = true
      this.#hash = after[1] || null
    }

    return this.#hash
  }

  async #getQr(): Promise<void> {
    if (this.#isLogged) {
      return
    }

    const buffer = await this.#client.get(`${this.#base_url}/get-qr-code`, {
      responseType: 'arraybuffer',
    })

    const qr = this.#qr?.result?.result || null
    const image = await Jimp.read(buffer.data)
    this.#qr.decode(image.bitmap)
    const result = this.#qr?.result?.result || null

    if (qr !== result) {
      this.emit('qrcode', result)
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(async () => {
        await this.#getQr()
      }, 100_000)

      this.on('logged', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }

  async #checkLogged(): Promise<void> {
    if (this.#isLogged) {
      return
    }

    const data = new URLSearchParams()
    data.append('hash', this.#hash || '')

    const response = await this.#client.post(`${this.#base_url}/check-qr-code`, data, {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': this.#base_url,
        'Referer': this.#base_url + '/',
        'Te': 'trailers',
      },
    })

    if (!!(response.data?.checkResult || false)) {
      this.#isLogged = true
      this.emit('logged', true)

      return
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000))
    await this.#checkLogged()
  }

  async init() {
    this.#hash = await this.#getHash()

    if (this.#isLogged) {
      return
    }

    this.on('qrcode', (qr) => {
      if (this.#options.showQr) {
        qrPrint.generate(qr, { small: true })
      }
    })

    await Promise.all([this.#getQr(), this.#checkLogged()])
  }

  async find(countryCode: CountryCode, phoneNumber: number | string): Promise<string[]> {
    // TODO: use Puppeteer - POST to /search then /list-tag
    this.#hash = await this.#getHash()

    const data = new URLSearchParams()
    data.append('hash', this.#hash || '')
    data.append('phoneNumber', encodeURI(`+${phoneNumber}`))
    data.append('countryCode', countryCode)

    const response = await this.#client.post(`${this.#base_url}/list-tag`, data, {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': this.#base_url,
        'Referer': this.#base_url + '/search',
        'Te': 'trailers',
      },
    })

    if (!response.data || response.data.status !== 'success') {
      return []
    }

    return response.data.tags.map(({ tag }: { tag: string }) => tag)
  }
}

export default Gtc
