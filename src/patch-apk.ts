import * as path from 'path'
import { once } from 'events'
import * as fs from './utils/fs'
import Listr from 'listr'
import chalk from 'chalk'

import { TaskOptions } from './cli'
import downloadTools from './tasks/download-tools'
import modifyManifest from './tasks/modify-manifest'
import createNetworkSecurityConfig from './tasks/create-netsec-config'
import disableCertificatePinning from './tasks/disable-certificate-pinning'
import observeAsync from './utils/observe-async'

export default function patchApk(taskOptions: TaskOptions) {
  const {
    inputPath,
    outputPath,
    tmpDir,
    apktool,
    uberApkSigner,
    wait,
  } = taskOptions

  const decodeDir = path.join(tmpDir, 'decode')
  const tmpApkPath = path.join(tmpDir, 'tmp.apk')

  let fallBackToAapt = false

  return new Listr([
    {
      title: 'Downloading tools',
      task: () => downloadTools(taskOptions),
    },
    {
      title: 'Decoding APK file',
      task: () => apktool.decode(inputPath, decodeDir),
    },
    {
      title: 'Modifying app manifest',
      task: async context => {
        const result = await modifyManifest(
          path.join(decodeDir, 'AndroidManifest.xml'),
        )

        context.usesAppBundle = result.usesAppBundle
      },
    },
    {
      title: 'Replacing network security config',
      task: () =>
        createNetworkSecurityConfig(
          path.join(decodeDir, `res/xml/nsc_mitm.xml`),
        ),
    },
    {
      title: 'Disabling certificate pinning',
      task: (_, task) => disableCertificatePinning(decodeDir, task),
    },
    {
      title: 'Waiting for you to make changes',
      enabled: () => wait,
      task: () =>
        observeAsync(async next => {
          process.stdin.setEncoding('utf-8')
          process.stdin.setRawMode(true)

          next('Press any key to continue.')
          await once(process.stdin, 'data')

          process.stdin.setRawMode(false)
          process.stdin.pause()
        }),
    },
    {
      title: 'Encoding patched APK file',
      task: () =>
        new Listr([
          {
            title: 'Encoding using AAPT2',
            task: (_, task) =>
              observeAsync(async next => {
                try {
                  await apktool
                    .encode(decodeDir, tmpApkPath, true)
                    .forEach(next)
                } catch {
                  task.skip('Failed, falling back to AAPT...')
                  fallBackToAapt = true
                }
              }),
          },
          {
            title: chalk`Encoding using AAPT {dim [fallback]}`,
            skip: () => !fallBackToAapt,
            task: () => apktool.encode(decodeDir, tmpApkPath, false),
          },
        ]),
    },
    {
      title: 'Signing patched APK file',
      task: () =>
        observeAsync(async next => {
          await uberApkSigner
            .sign([tmpApkPath], { zipalign: true })
            .forEach(line => next(line))

          await fs.copyFile(tmpApkPath, outputPath)
        }),
    },
  ])
}

export function showAppBundleWarning() {
  console.log(chalk`{yellow
  {inverse.bold  WARNING }

  This app seems to be using {bold Android App Bundle} which means that you
  will likely run into problems installing it. That's because this app
  is made out of {bold multiple APK files} and you've only got one of them.

  If you want to patch an app like this with {bold apk-mitm}, you'll have to
  supply it with all the APKs. You have two options for doing this:

  – download a {bold *.xapk} file {dim (for example from https://apkpure.com​)}
  – export a {bold *.apks} file {dim (using https://github.com/Aefyr/SAI​)}

  You can then run {bold apk-mitm} again with that file to patch the bundle.}`)
}
