import { access, readFile, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import process from 'node:process'

const exampleFragmentPath = 'fragments/example'
const requiredFragmentFiles = ['Component.tsx', 'main.tsx', 'index.html', 'roomy.fragment.json', 'skill.md']
const genericFragmentNamePattern = /(^|[-_])(workspace|dashboard|main|home|app)([-_]|$)/i
const surfaceKeywordPatterns = [
  /\blist\b|\bsearch\b|\bfilter\b/i,
  /\bnew\b|\bcreate\b|\badd\b/i,
  /\bedit\b|\bsave\b|\bupdate\b/i,
  /\bdelete\b|\bremove\b/i,
  /\bdetail\b|\bpreview\b|\bread[-_ ]?only\b/i,
  /\bimport\b|\bexport\b/i,
  /\bchart\b|\bcard\b|\btable\b|\bsummary\b/i,
  /\bform\b|\binput\b|\btextarea\b/i,
]

const commandTimeoutMs = 120_000

async function main() {
  const manifest = await readManifest()
  const isTemplate = manifest.name === '__APP_NAME__'

  await assertNoExampleFragment(manifest, { isTemplate })
  await assertFragmentArchitecture(manifest, { isTemplate })
  await runBuild()
  await assertDistPopulated()
  await assertFragmentBuildEntries(manifest, { isTemplate })
  await run('npm', ['run', 'typecheck'], { label: 'typecheck' })
  await run('npm', ['run', 'test'], { label: 'test' })
  await assertNoExampleFragment(manifest, { isTemplate })
  await assertFragmentArchitecture(manifest, { isTemplate })
  await assertDistPopulated()
  await assertFragmentBuildEntries(manifest, { isTemplate })
}

async function readManifest() {
  try {
    return JSON.parse(await readFile('roomy.app.json', 'utf8'))
  } catch (error) {
    throw new Error(`could not read roomy.app.json while checking fragments: ${error.message}`)
  }
}

async function assertNoExampleFragment(manifest, { isTemplate }) {
  if (isTemplate) {
    console.log('verify: scaffold template detected; skipping generated-app example fragment check.')
    return
  }

  try {
    await access(exampleFragmentPath)
    throw new Error(`${exampleFragmentPath}/ is still present. Replace or delete the scaffold example fragment before shipping a real app.`)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      // Good: the instructional scaffold fragment was removed.
    } else {
      throw error
    }
  }

  const fragments = Array.isArray(manifest.fragments) ? manifest.fragments : []
  const exampleReference = fragments.find((fragment) => {
    if (fragment === 'example') return true
    if (!fragment || typeof fragment !== 'object') return false

    return fragment.id === 'example' || fragment.name === 'example' || String(fragment.path ?? '').includes('fragments/example')
  })

  if (exampleReference) {
    throw new Error('roomy.app.json still references the scaffold example fragment. Remove it before shipping a real app.')
  }
}

async function assertFragmentArchitecture(manifest, { isTemplate }) {
  if (isTemplate) {
    console.log('verify: scaffold template detected; skipping generated-app fragment architecture check.')
    return
  }

  const fragments = getRegisteredFragmentNames(manifest)

  for (const fragmentName of fragments) {
    await assertFragmentFiles(fragmentName)
  }

  await assertNoUnregisteredFragments(fragments)
  await assertNoGenericMegaFragment(fragments)
}

function getRegisteredFragmentNames(manifest) {
  const fragments = Array.isArray(manifest.fragments) ? manifest.fragments : []

  return fragments
    .map((fragment) => {
      if (typeof fragment === 'string') return fragment
      if (!fragment || typeof fragment !== 'object') return undefined
      return fragment.id ?? fragment.name ?? fragment.path?.split('/').filter(Boolean).at(-1)
    })
    .filter((fragmentName) => typeof fragmentName === 'string' && fragmentName.length > 0)
}

async function assertFragmentFiles(fragmentName) {
  for (const fileName of requiredFragmentFiles) {
    const filePath = `fragments/${fragmentName}/${fileName}`

    try {
      await access(filePath)
    } catch (error) {
      throw new Error(`registered fragment "${fragmentName}" is missing ${fileName}. Every real fragment must include ${requiredFragmentFiles.join(', ')}. ${error.message}`)
    }
  }
}

async function assertNoUnregisteredFragments(registeredFragments) {
  let entries

  try {
    entries = await readdir('fragments', { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return
    throw new Error(`could not inspect fragments/ while checking fragment registration: ${error.message}`)
  }

  const registered = new Set(registeredFragments)

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'example') continue

    const hasFragmentManifest = await pathExists(`fragments/${entry.name}/roomy.fragment.json`)
    if (hasFragmentManifest && !registered.has(entry.name)) {
      throw new Error(`fragment "${entry.name}" exists but is not registered in roomy.app.json. Register it or remove the dead fragment directory.`)
    }
  }
}

async function assertNoGenericMegaFragment(fragments) {
  if (fragments.length !== 1) return

  const [fragmentName] = fragments
  if (!genericFragmentNamePattern.test(fragmentName)) return

  let componentSource = ''
  let skillSource = ''

  try {
    componentSource = await readFile(`fragments/${fragmentName}/Component.tsx`, 'utf8')
  } catch {
    // Missing required files are reported by assertFragmentFiles.
  }

  try {
    skillSource = await readFile(`fragments/${fragmentName}/skill.md`, 'utf8')
  } catch {
    // Missing required files are reported by assertFragmentFiles.
  }

  const combinedSource = `${fragmentName}\n${componentSource}\n${skillSource}`
  const matchedSurfaceCount = surfaceKeywordPatterns.filter((pattern) => pattern.test(combinedSource)).length

  if (matchedSurfaceCount >= 3) {
    throw new Error(
      `app has only one generic fragment ("${fragmentName}") that appears to hide multiple user-facing surfaces. Split multi-surface apps into focused fragments such as list, create, detail, editor, chart, or import/export fragments.`,
    )
  }
}

async function assertFragmentBuildEntries(manifest, { isTemplate }) {
  if (isTemplate) return

  for (const fragmentName of getRegisteredFragmentNames(manifest)) {
    const builtEntryPath = `dist/fragments/${fragmentName}/index.html`

    try {
      await access(builtEntryPath)
    } catch (error) {
      throw new Error(`registered fragment "${fragmentName}" is missing built standalone entry ${builtEntryPath}. ${error.message}`)
    }
  }
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}

async function runBuild() {
  try {
    await run('npm', ['run', 'build'], { label: 'build' })
    return
  } catch (error) {
    console.error(`\nverify: npm run build failed or timed out; retrying once with npx vite build.`)
    console.error(`verify: original build failure: ${error.message}`)
  }

  await run('npx', ['vite', 'build'], { label: 'vite build' })
}

async function assertDistPopulated() {
  let entries

  try {
    entries = await readdir('dist')
  } catch (error) {
    throw new Error(`dist/ is missing after build. The app is broken and must not be attached. ${error.message}`)
  }

  if (entries.length === 0) {
    throw new Error('dist/ is empty after build. The app is broken and must not be attached.')
  }

  console.log(`verify: dist/ exists and contains ${entries.length} entries.`)
}

function run(command, args, { label }) {
  return new Promise((resolve, reject) => {
    console.log(`\nverify: running ${label}...`)

    const child = spawn(command, args, {
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      shell: process.platform === 'win32',
    })

    const timeout = setTimeout(() => {
      killChild(child)
      reject(new Error(`${label} timed out after ${commandTimeoutMs / 1000}s`))
    }, commandTimeoutMs)

    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })

    child.on('exit', (code, signal) => {
      clearTimeout(timeout)

      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`${label} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`))
    })
  })
}

function killChild(child) {
  if (process.platform === 'win32') {
    child.kill('SIGTERM')
    return
  }

  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

main().catch((error) => {
  console.error(`\nverify: failed: ${error.message}`)
  process.exitCode = 1
})
