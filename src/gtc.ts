import os from 'os'
import jsQr from 'jsqr'
import Jimp from 'jimp'
import fs from 'fs/promises'
import EventEmitter from 'events'
import qrPrint from 'qrcode-terminal'
import puppeteer from 'puppeteer-extra'
import { CookieJar } from 'tough-cookie'
import axios, { AxiosInstance } from 'axios'
import { CookieParam, Page } from 'puppeteer'
import randomUseragent from 'random-useragent'
import { wrapper } from 'axios-cookiejar-support'
import { FileCookieStore } from 'tough-cookie-file-store'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { CountryCode, GtcOptions, GtcResult } from '../types/gtc'

class Gtc extends EventEmitter {
  #base_url = 'https://web.getcontact.com'
  #options: GtcOptions
  #hash?: string | null
  #jar: CookieJar
  #http: AxiosInstance
  #qr?: string | null
  #isLogged: boolean = false

  constructor(options: GtcOptions) {
    super()

    this.#options = options
    this.#options.cookiePath = this.#options?.cookiePath || `${os.tmpdir()}/cookie.json`
    this.#jar = new CookieJar(new FileCookieStore(this.#options.cookiePath))

    this.#http = wrapper(
      axios.create({
        jar: this.#jar,
        headers: { 'User-Agent': randomUseragent.getRandom((ua) => ua.browserName === 'Chrome') },
      })
    )
  }

  async #getHash() {
    const result = await this.#http.get(this.#base_url).then((res) => res.data)
    const before = result.match(/hash: '([a-fA-F0-9]+)'/)
    const after = result.match(/<input type="hidden" name="hash" value="([a-fA-F0-9]+)"\/>/)

    if (before) {
      this.#isLogged = false
      this.#hash = before[1] || null
    }

    if (after) {
      this.#isLogged = true
      this.#hash = after[1] || null
    }

    this.emit('logged', this.#isLogged)
    return this.#hash
  }

  async #getQr(): Promise<void> {
    if (this.#isLogged) {
      return
    }

    const buffer = await this.#http.get(`${this.#base_url}/get-qr-code`, {
      responseType: 'arraybuffer',
    })

    const image = await Jimp.read(buffer.data)
    const qr = jsQr(
      new Uint8ClampedArray(image.bitmap.data),
      image.bitmap.width,
      image.bitmap.height
    )
    const result = qr?.data || null

    if (this.#qr !== result) {
      this.emit('qrcode', result)
    }

    this.#qr = result

    return new Promise((resolve) => {
      const timeout = setTimeout(async () => {
        await this.#getQr()
      }, 20_000)

      this.on('logged', (logged) => {
        if (logged) {
          clearTimeout(timeout)
          resolve()
        }
      })
    })
  }

  async #checkLogged(): Promise<void> {
    if (this.#isLogged) {
      return
    }

    const data = new URLSearchParams()
    data.append('hash', this.#hash || '')

    const response = await this.#http.post(`${this.#base_url}/check-qr-code`, data, {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': this.#base_url,
        'Referer': this.#base_url + '/',
        'Te': 'trailers',
      },
    })

    if (response.data?.checkResult || false) {
      this.#isLogged = true
      this.emit('logged', this.#isLogged)

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

    if (this.#options.showQr) {
      this.on('qrcode', (qr) => {
        qrPrint.generate(qr, { small: true })
      })
    }

    await Promise.all([this.#getQr(), this.#checkLogged()])
  }

  async #loadCookie(page: Page) {
    const string = await fs.readFile(this.#options.cookiePath!, { encoding: 'utf8' })

    const cookies: CookieParam[] = Object.values(JSON.parse(string)).flatMap((domain: any) =>
      Object.values(domain).flatMap((path: any) =>
        Object.values(path).map((cookie: any) => ({
          name: cookie.key,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          expires: cookie.expires ? Date.parse(cookie.expires) / 1000 : undefined,
          size: JSON.stringify(cookie).length,
          httpOnly: cookie.httpOnly || false,
          secure: cookie.secure || false,
          session: cookie.expires === undefined,
          priority: 'Medium',
          sameParty: false,
          sourceScheme: 'Secure',
        }))
      )
    )

    await page.setCookie(...cookies)
  }

  async find(countryCode: CountryCode, phoneNumber: number | string): Promise<GtcResult | null> {
    await this.#checkLogged()

    const browser = await puppeteer.use(StealthPlugin()).launch(this.#options.puppeteer)
    const page = await browser.newPage()

    await this.#loadCookie(page)
    await page.goto(`${this.#base_url}`)
    await page.waitForSelector('[name="phoneNumber"]')

    await page.evaluate(
      (countryCode, phoneNumber) => {
        const country: HTMLInputElement = document.querySelector('[name="countryCode"]')!
        const phone: HTMLInputElement = document.querySelector('[name="phoneNumber"]')!
        const submit: HTMLElement = document.querySelector('#submitButton')!

        country.value = countryCode
        phone.value = String(phoneNumber)
        submit.click()
      },
      countryCode,
      phoneNumber
    )

    try {
      await page.waitForSelector('.box.r-profile-box', { timeout: 0 })

      const profile = await page.evaluate(() => {
        const name = document.querySelector('.rpbi-info h1')?.innerHTML?.trim() || null
        const detail = document.querySelector('.rpbi-info em')?.innerHTML?.split('-')
        const provider = detail?.[0]?.trim() || null
        const country = detail?.[1]?.trim() || null
        const img = /url\('([^']+)'\)/.exec(document.querySelector('.rpbi-img')?.innerHTML || '')
        const picture = img ? img[1] : null

        return { name, provider, country, picture, tags: null }
      })

      await browser.close()

      if (!profile.provider && !profile.country) {
        return null
      }

      const data = new URLSearchParams()
      data.append('hash', this.#hash || '')
      data.append('phoneNumber', encodeURI(`+${phoneNumber}`))
      data.append('countryCode', countryCode)

      const response = await this.#http.post(`${this.#base_url}/list-tag`, data, {
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Origin': this.#base_url,
          'Referer': this.#base_url + '/search',
          'Te': 'trailers',
        },
      })

      if (!response.data || response.data.status !== 'success') {
        return profile
      }

      return { ...profile, tags: response.data.tags.map(({ tag }: { tag: string }) => tag) }
    } catch (error) {
      await browser.close()
      this.emit('error', error)

      return null
    }
  }
}

export default Gtc
