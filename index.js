const puppeteer = require('puppeteer')
const spawn = require('child_process').spawn
const tkt = require('tkt')
const fs = require('fs')
const path = require('path')
const express = require("express");
const app = express();
const PORT = process.env.PORT || 80;

function createRendererFactory(
  url,
  { scale = 1, alpha = false, launchArgs = [] } = {},
) {
  const DATA_URL_PREFIX = 'data:image/png;base64,'
  return function createRenderer({ name = 'Worker' } = {}) {
    const promise = (async () => {
      const browser = await puppeteer.launch({
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
        ],
      })
      const page = await browser.newPage()
      page.on('console', (msg) => console.log('PAGE LOG:', msg.text()))
      page.on('pageerror', (msg) => console.log('PAGE ERROR:', msg))
      await page.goto(url, { waitUntil: 'load' })
      const info = await page.evaluate(`(async () => {
        let deadline = Date.now() + 10000
        while (Date.now() < deadline) {
          if (typeof getInfo === 'function') {
            break
          }
          await new Promise(r => setTimeout(r, 1000))
        }
        const info = await getInfo()
        if (!info.width || !info.height) {
          Object.assign(info, {
            width: document.querySelector('#scene').offsetWidth,
            height: document.querySelector('#scene').offsetHeight,
          })
        }
        return info
      })()`)
      await page.setViewport({
        width: info.width,
        height: info.height,
        deviceScaleFactor: scale,
      })
      return { browser, page, info }
    })()
    let rendering = false
    return {
      async getInfo() {
        return (await promise).info
      },
      async render(i) {
        if (rendering) {
          throw new Error('render() may not be called concurrently!')
        }
        rendering = true
        try {
          const marks = [Date.now()]
          const { page, info } = await promise
          marks.push(Date.now())
          const result = await page.evaluate(`seekToFrame(${i})`)
          marks.push(Date.now())
          const buffer =
            typeof result === 'string' && result.startsWith(DATA_URL_PREFIX)
              ? Buffer.from(result.substr(DATA_URL_PREFIX.length), 'base64')
              : await page.screenshot({
                  clip: { x: 0, y: 0, width: info.width, height: info.height },
                  omitBackground: alpha,
                })
          marks.push(Date.now())
          console.log(
            name,
            `render(${i}) finished`,
            `timing=${marks
              .map((v, i, a) => (i === 0 ? null : v - a[i - 1]))
              .slice(1)}`,
          )
          return buffer
        } finally {
          rendering = false
        }
      },
      async end() {
        const { browser } = await promise
        browser.close()
      },
    }
  }
}

function createParallelRender(max, rendererFactory) {
  const available = []
  const working = new Set()
  let nextWorkerId = 1
  let waiting = null
  function obtainWorker() {
    if (available.length + working.size < max) {
      const id = nextWorkerId++
      const worker = { id, renderer: rendererFactory(`Worker ${id}`) }
      available.push(worker)
      console.log('Spawn worker %d', worker.id)
      if (waiting) waiting.nudge()
    }
    if (available.length > 0) {
      const worker = available.shift()
      working.add(worker)
      return worker
    }
    return null
  }
  const work = async (fn, taskDescription) => {
    for (;;) {
      const worker = obtainWorker()
      if (!worker) {
        if (!waiting) {
          let nudge
          const promise = new Promise((resolve) => {
            nudge = () => {
              waiting = null
              resolve()
            }
          })
          waiting = { promise, nudge }
        }
        await waiting.promise
        continue
      }
      try {
        console.log('Worker %d: %s', worker.id, taskDescription)
        const result = await fn(worker.renderer)
        available.push(worker)
        if (waiting) waiting.nudge()
        return result
      } catch (e) {
        worker.renderer.end()
        throw e
      } finally {
        working.delete(worker)
      }
    }
  }
  return {
    async getInfo() {
      return work((r) => r.getInfo(), 'getInfo')
    },
    async render(i) {
      return work((r) => r.render(i), `render(${i})`)
    },
    async end() {
      return Promise.all(
        [...available, ...working].map((r) => r.renderer.end()),
      )
    },
  }
}

function ffmpegOutput(fps, outPath, { alpha }) {
  const ffmpeg = spawn('ffmpeg', [
    ...['-f', 'image2pipe'],
    ...['-framerate', `${fps}`],
    ...['-i', '-'],
    ...(alpha
      ? [
          // https://stackoverflow.com/a/12951156/559913
          ...['-c:v', 'qtrle'],

          // https://unix.stackexchange.com/a/111897
          // ...['-c:v', 'prores_ks'],
          // ...['-pix_fmt', 'yuva444p10le'],
          // ...['-profile:v', '4444'],
          // https://www.ffmpeg.org/ffmpeg-codecs.html#Speed-considerations
          // ...['-qscale', '4']
        ]
      : [
          ...['-c:v', 'libx264'],
          ...['-crf', '16'],
          ...['-preset', 'ultrafast'],
          // https://trac.ffmpeg.org/wiki/Encode/H.264#Encodingfordumbplayers
          ...['-pix_fmt', 'yuv420p'],
        ]),
    '-y',
    outPath,
  ])
  ffmpeg.stderr.pipe(process.stderr)
  ffmpeg.stdout.pipe(process.stdout)
  return {
    writePNGFrame(buffer, _frameNumber) {
      ffmpeg.stdin.write(buffer)
    },
    end() {
      ffmpeg.stdin.end()
    },
  }
}

function pngFileOutput(dirname) {
  require('mkdirp').sync(dirname)
  return {
    writePNGFrame(buffer, frameNumber) {
      const basename = 'frame' + `${frameNumber}`.padStart(6, '0') + '.png'
      fs.writeFileSync(path.join(dirname, basename), buffer)
    },
    end() {},
  }
}

tkt
async function main(
  url = `file://${__dirname}/examples/gsap-hello-world.html?render`,
  video = 'video.mp4',
  parallelism = require('os').cpus().length,
  startarg = 0,
  endarg = null,
  png = null,
  alpha = null,
  scale = 1
) {
  const renderer = createParallelRender(
    parallelism,
    createRendererFactory(url, {
      scale: scale,
      alpha: alpha,
    }),
  )
  const info = await renderer.getInfo()
  console.log('Movie info:', info)

  const outputs = []
  if (video) {
    outputs.push(
      ffmpegOutput(info.fps, video, {
        alpha: alpha,
      }),
    )
  }
  if (png != null) {
    outputs.push(pngFileOutput(png))
  }

  const promises = []
  const start = startarg || 0
  const end = endarg || info.numberOfFrames
  for (let i = start; i < end; i++) {
    promises.push({ promise: renderer.render(i), frame: i })
  }
  for (let i = 0; i < promises.length; i++) {
    console.log(
      'Render frame %d %d/%d',
      promises[i].frame,
      i,
      promises.length,
    )
    const buffer = await promises[i].promise
    for (const o of outputs) o.writePNGFrame(buffer, promises[i].frame)
  }
  for (const o of outputs) o.end()
  renderer.end()
}

app.get("/", (req, res) => {
  res.end(`
  <div>
    <nav>
      <ul>
        <li>
          <a href="/">Home</a>
        </li>
        <li>
          <a href="/about">About</a>
        </li>
      </ul>
    </nav>
    <h1>Home page</h1>
  </div>
  `);
});

app.get("/about", (req, res) => {
  res.end(`
   <div>
    <nav>
      <ul>
        <li>
          <a href="/">Home</a>
        </li>
        <li>
          <a href="/about">About</a>
        </li>
      </ul>
    </nav>
    <h1>About page</h1>
  </div>
  `);
});
app.get('/meucu', async (req, res, next) => main());
app.listen(PORT, () => {
  console.log("server has been started");
});
