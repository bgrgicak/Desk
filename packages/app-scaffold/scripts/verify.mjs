import { readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import process from 'node:process'

const commandTimeoutMs = 120_000

async function main() {
  await runBuild()
  await assertDistPopulated()
  await run('npm', ['run', 'typecheck'], { label: 'typecheck' })
  await run('npm', ['run', 'test'], { label: 'test' })
  await assertDistPopulated()
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
