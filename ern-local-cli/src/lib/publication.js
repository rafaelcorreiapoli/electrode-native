// @flow

import {
  generateMiniAppsComposite,
  IosGenerator,
  AndroidGenerator,
  ContainerGenerator
} from 'ern-container-gen'
import {
  utils as coreUtils,
  compatibility,
  CodePushSdk,
  PackagePath,
  config,
  MiniApp,
  NativeApplicationDescriptor,
  Platform,
  spin,
  reactnative
} from 'ern-core'
import type {
  CodePushPackage
} from 'ern-core'

import inquirer from 'inquirer'
import _ from 'lodash'
import tmp from 'tmp'
import path from 'path'
import fs from 'fs'
import shell from 'shelljs'
import * as constants from './constants'

// Run container generator locally, without relying on the Cauldron, given a list of miniapp packages
// The string used to represent a miniapp package can be anything supported by `yarn add` command
// For example, the following miniapp strings are all valid
// FROM NPM => react-native-miniapp@1.2.3
// FROM GIT => git@github.com:username/MiniAppp.git
// FROM FS  => file:/Users/username/Code/MiniApp
export async function runLocalContainerGen (
miniappPackagesPaths: Array<PackagePath>,
jsApiImplsPackagePaths: Array<PackagePath>,
platform: 'android' | 'ios', {
  outDir = `${Platform.rootDirectory}/containergen`,
  extraNativeDependencies = [],
  ignoreRnpmAssets = false
}: {
  outDir?: string,
  extraNativeDependencies: Array<PackagePath>,
  ignoreRnpmAssets?: boolean
} = {}) {
  try {
    const nativeDependenciesStrings: Set <string> = new Set()
    let miniapps: Array<MiniApp> = []

    for (const miniappPackagePath of miniappPackagesPaths) {
      log.debug(`Retrieving ${miniappPackagePath.toString()}`)

      let currentMiniApp
      if (miniappPackagePath.isFilePath) {
        currentMiniApp = MiniApp.fromPath(miniappPackagePath.basePath)
      } else {
        currentMiniApp = await MiniApp.fromPackagePath(miniappPackagePath)
      }

      miniapps.push(currentMiniApp)

      const nativeDependencies = await currentMiniApp.getNativeDependencies()
      const supportedNativeDependencies = [
        ...nativeDependencies.apis,
        ...nativeDependencies.nativeApisImpl,
        ...nativeDependencies.thirdPartyInManifest ]
      supportedNativeDependencies.forEach(d => nativeDependenciesStrings.add(d.toString()))
    }

    let nativeDependencies = _.map(Array.from(nativeDependenciesStrings), d => PackagePath.fromString(d))
    nativeDependencies = nativeDependencies.concat(extraNativeDependencies)

    // Verify uniqueness of native dependencies (that all miniapps are using the same
    // native dependencies version). This is a requirement in order to generate a proper container
    const nativeDependenciesWithoutVersion: Array<string> = _.map(nativeDependencies, d => d.basePath)
    const duplicateNativeDependencies =
      _(nativeDependenciesWithoutVersion).groupBy().pickBy(x => x.length > 1).keys().value()
    if (duplicateNativeDependencies.length > 0) {
      throw new Error(`The following native dependencies are not using the same version: ${duplicateNativeDependencies}`)
    }

    const generator = getGeneratorForPlatform(platform)

    await spin('Generating Container', generator.generate({
      miniApps: miniapps,
      jsApiImpls: jsApiImplsPackagePaths,
      outDir,
      plugins: nativeDependencies,
      pluginsDownloadDir: tmp.dirSync({ unsafeCleanup: true }).name,
      compositeMiniAppDir: tmp.dirSync({ unsafeCleanup: true }).name,
      ignoreRnpmAssets
    }))
  } catch (e) {
    log.error(`runLocalContainerGen failed: ${e}`)
    throw e
  }
}

function getGeneratorForPlatform (platform: string) : ContainerGenerator {
  switch (platform) {
    case 'android': return new AndroidGenerator()
    case 'ios': return new IosGenerator()
    default: throw new Error(`Unsupported platform : ${platform}`)
  }
}

// Run container generator using the Cauldron, given a native application descriptor
export async function runCauldronContainerGen (
napDescriptor: NativeApplicationDescriptor, {
  outDir,
  compositeMiniAppDir
}: {
  outDir?: string,
  compositeMiniAppDir?: string
} = {}) {
  try {
    const cauldron = await coreUtils.getCauldronInstance()
    const plugins = await cauldron.getNativeDependencies(napDescriptor)
    const miniapps = await cauldron.getContainerMiniApps(napDescriptor)
    const jsApiImpls = await cauldron.getContainerJsApiImpls(napDescriptor)
    const pathToYarnLock = await cauldron.getPathToYarnLock(napDescriptor, constants.CONTAINER_YARN_KEY)

    if (!napDescriptor.platform) {
      throw new Error(`napDescriptor (${napDescriptor.toString()}) does not contain a platform`)
    }

    if (!compositeMiniAppDir) {
      compositeMiniAppDir = tmp.dirSync({ unsafeCleanup: true }).name
    }

    const platform = napDescriptor.platform
    const containerGeneratorConfig = await cauldron.getContainerGeneratorConfig(napDescriptor)

    const miniAppsInstances = []
    for (const miniapp of miniapps) {
      miniAppsInstances.push(await MiniApp.fromPackagePath(miniapp))
    }

    const generator = getGeneratorForPlatform(platform)

    await spin(
      `Creating Container for ${napDescriptor.toString()} from Cauldron`,
      generator.generate({
        miniApps: miniAppsInstances,
        jsApiImpls,
        outDir: outDir || path.join(Platform.rootDirectory, 'containergen', 'out', platform),
        plugins,
        ignoreRnpmAssets: containerGeneratorConfig && containerGeneratorConfig.ignoreRnpmAssets,
        pluginsDownloadDir: tmp.dirSync({ unsafeCleanup: true }).name,
        compositeMiniAppDir,
        pathToYarnLock: pathToYarnLock || undefined
      }))
  } catch (e) {
    log.error(`runCauldronContainerGen failed: ${e}`)
    throw e
  }
}

export async function performCodePushPatch (
  napDescriptor: NativeApplicationDescriptor,
  deploymentName: string,
  label: string, {
    isDisabled,
    isMandatory,
    rollout
  } : {
    isDisabled?: boolean,
    isMandatory?: boolean,
    rollout?: number
  }) {
  try {
    var cauldron = await coreUtils.getCauldronInstance()
    const codePushSdk = getCodePushSdk()
    await cauldron.beginTransaction()
    const appName = await getCodePushAppName(napDescriptor)
    await codePushSdk.patch(
      appName,
      deploymentName,
      label, {
        isDisabled,
        isMandatory,
        rollout
      })
    await cauldron.updateCodePushEntry(
      napDescriptor,
      deploymentName,
      label, {
        isDisabled,
        isMandatory,
        rollout
      })
    await cauldron.commitTransaction(`CodePush patched ${napDescriptor.toString()} ${deploymentName} ${label}`)
  } catch (e) {
    if (cauldron) {
      await cauldron.discardTransaction()
    }
    log.error(`[performCodePushPatch] ${e}`)
    throw e
  }
}

export async function performCodePushPromote (
  sourceNapDescriptor: NativeApplicationDescriptor,
  targetNapDescriptors: Array<NativeApplicationDescriptor>,
  sourceDeploymentName: string,
  targetDeploymentName: string, {
    force = false,
    mandatory,
    rollout
  } : {
    force?: boolean,
    mandatory?: boolean,
    rollout?: number
  } = {}) {
  try {
    const codePushSdk = getCodePushSdk()
    var cauldron = await coreUtils.getCauldronInstance()
    await cauldron.beginTransaction()
    const cauldronCommitMessage = [
      `CodePush release promotion of ${sourceNapDescriptor.toString()} ${sourceDeploymentName} to ${targetDeploymentName} of`
    ]

    for (const targetNapDescriptor of targetNapDescriptors) {
      if (!targetNapDescriptor.version) {
        throw new Error(`Missing version in ${targetNapDescriptor.toString()}`)
      }

      const miniApps = await cauldron.getCodePushMiniApps(sourceNapDescriptor, sourceDeploymentName)
      if (!miniApps) {
        log.error(`No MiniApps were found in source deployment [${sourceDeploymentName} for ${sourceNapDescriptor.toString()}] `)
        log.error(`Skipping promotion to ${targetNapDescriptor.toString()}`)
        continue
      }

      const jsApiImpls = await cauldron.getCodePushJsApiImpls(sourceNapDescriptor, sourceDeploymentName)

      const nativeDependenciesVersionAligned =
        await areMiniAppsNativeDependenciesAlignedWithTargetApplicationVersion(miniApps, targetNapDescriptor)

      if (!nativeDependenciesVersionAligned && force) {
        log.warn('Native dependencies versions are not aligned but ignoring due to the use of force flag')
      } else if (!nativeDependenciesVersionAligned && !force) {
        if (!await askUserToForceCodePushPublication()) {
          return log.info('CodePush promotion aborted')
        }
      }

      const appName = await getCodePushAppName(sourceNapDescriptor)
      const appVersion = await getCodePushTargetVersionName(targetNapDescriptor, targetDeploymentName)
      const result = await spin(`Promoting release to ${appVersion}`,
        codePushSdk.promote(appName, sourceDeploymentName, targetDeploymentName, {
          appVersion,
          isMandatory: mandatory,
          rollout
        }))

      const sourceYarnLockId = await cauldron.getYarnLockId(sourceNapDescriptor, sourceDeploymentName)
      if (!sourceYarnLockId) {
        log.error(`No yarn.lock was found in source deployment [${sourceDeploymentName} for ${sourceNapDescriptor.toString()}]`)
        log.error(`Skipping promotion to ${targetNapDescriptor.toString()}`)
        continue
      }
      await cauldron.updateYarnLockId(targetNapDescriptor, targetDeploymentName, sourceYarnLockId)

      await cauldron.addCodePushEntry(
        targetNapDescriptor, {
          deploymentName: targetDeploymentName,
          isMandatory: result.isMandatory,
          appVersion: result.appVersion,
          size: result.size,
          releaseMethod: result.releaseMethod,
          label: result.label,
          releasedBy: result.releasedBy,
          rollout: result.rollout
        },
        miniApps,
        jsApiImpls || [])

      cauldronCommitMessage.push(`- ${targetNapDescriptor.toString()}`)
    }
    await spin(`Updating Cauldron`, cauldron.commitTransaction(cauldronCommitMessage))
  } catch (e) {
    if (cauldron) {
      await cauldron.discardTransaction()
    }
    log.error(`[performCodePushPromote] ${e}`)
    throw e
  }
}

export async function performCodePushOtaUpdate (
napDescriptor: NativeApplicationDescriptor,
deploymentName: string,
miniApps: Array<PackagePath>,
jsApiImpls: Array<PackagePath>, {
  force = false,
  codePushIsMandatoryRelease = false,
  codePushRolloutPercentage,
  pathToYarnLock,
  skipConfirmation = false
}: {
  force: boolean,
  codePushIsMandatoryRelease?: boolean,
  codePushRolloutPercentage?: number,
  pathToYarnLock?: string,
  skipConfirmation?: boolean
} = {}) {
  try {
    const codePushSdk = getCodePushSdk()
    var cauldron = await coreUtils.getCauldronInstance()
    const plugins = await cauldron.getNativeDependencies(napDescriptor)
    await cauldron.beginTransaction()
    const codePushPlugin = _.find(plugins, p => p._basePath === 'react-native-code-push')
    if (!codePushPlugin) {
      throw new Error('react-native-code-push plugin is not in native app !')
    }

    const tmpWorkingDir = tmp.dirSync({ unsafeCleanup: true }).name

    const miniAppsNativeDependenciesVersionAligned =
      await areMiniAppsNativeDependenciesAlignedWithTargetApplicationVersion(miniApps, napDescriptor)

    if (!miniAppsNativeDependenciesVersionAligned && force) {
      log.warn('Native dependencies versions of MiniApps are not aligned but ignoring due to the use of force flag')
    } else if (!miniAppsNativeDependenciesVersionAligned && !force) {
      if (!await askUserToForceCodePushPublication()) {
        throw new Error('CodePush publication aborted')
      }
    }

    const latestCodePushedMiniApps = await cauldron.getCodePushMiniApps(napDescriptor, deploymentName)
    const latestCodePushedJsApiImpls = await cauldron.getCodePushJsApiImpls(napDescriptor, deploymentName)

    // We need to include, in this CodePush bundle, all the MiniApps and JS API implementations that were part
    // of the previous CodePush. We will override versions of the MiniApps and JS API implementations with
    // the one provided to this function, and keep other ones intact.
    // For example, if previous CodePush bundle was containing MiniAppOne@1.0.0 and
    // MiniAppTwo@1.0.0 and this method is called to CodePush MiniAppOne@2.0.0, then
    // the bundle we will push will container MiniAppOne@2.0.0 and MiniAppTwo@1.0.0.
    // If this the first ever CodePush bundle for this specific native application version
    // then the reference miniapp versions are the one from the container.
    let referenceMiniAppsToCodePush = latestCodePushedMiniApps
    if (!referenceMiniAppsToCodePush || referenceMiniAppsToCodePush.length === 0) {
      referenceMiniAppsToCodePush = await cauldron.getContainerMiniApps(napDescriptor)
    }

    let referenceJsApiImplsToCodePush = latestCodePushedJsApiImpls
    if (!referenceJsApiImplsToCodePush || referenceJsApiImplsToCodePush.length === 0) {
      referenceJsApiImplsToCodePush = await cauldron.getContainerJsApiImpls(napDescriptor)
    }

    const miniAppsToBeCodePushed = _.unionBy(
      miniApps, referenceMiniAppsToCodePush, x => x.basePath)

    const jsApiImplsToBeCodePushed = _.unionBy(
      jsApiImpls, referenceJsApiImplsToCodePush, x => x.basePath)

    // If force or skipFinalConfirmation was not provided as option, we ask user for confirmation before proceeding
    // with code-push publication
    const userConfirmedCodePushPublication = force || skipConfirmation || await askUserToConfirmCodePushPublication(miniAppsToBeCodePushed, jsApiImplsToBeCodePushed)

    if (!userConfirmedCodePushPublication) {
      return log.info('CodePush publication aborted')
    } else {
      log.info('Getting things ready for CodePush publication')
    }

    const pathsToMiniAppsToBeCodePushed = _.map(miniAppsToBeCodePushed, m => PackagePath.fromString(m.toString()))
    const pathToJsApiImplsToBeCodePushed = _.map(jsApiImplsToBeCodePushed, j => PackagePath.fromString(j.toString()))

    await spin('Generating composite module',
       generateMiniAppsComposite(pathsToMiniAppsToBeCodePushed, tmpWorkingDir, {pathToYarnLock}, pathToJsApiImplsToBeCodePushed))

    const bundleOutputDirectory = path.join(tmpWorkingDir, 'bundleOut')
    shell.mkdir('-p', bundleOutputDirectory)
    const platform = napDescriptor.platform || ''
    const bundleOutputPath = platform === 'android'
      ? path.join(bundleOutputDirectory, 'index.android.bundle')
      : path.join(bundleOutputDirectory, 'MiniApp.jsbundle')

    await spin('Generating composite bundle for miniapps', reactnative.bundle({
      entryFile: `index.${platform}.js`,
      dev: false,
      bundleOutput: bundleOutputPath,
      platform,
      assetsDest: bundleOutputDirectory
    }))

    const appName = await getCodePushAppName(napDescriptor)
    const targetVersionName = await getCodePushTargetVersionName(napDescriptor, deploymentName)

    const codePushResponse: CodePushPackage = await spin('Releasing bundle through CodePush', codePushSdk.releaseReact(
      appName,
      deploymentName,
      bundleOutputDirectory,
      targetVersionName, {
        isMandatory: codePushIsMandatoryRelease,
        rollout: codePushRolloutPercentage
      }))

    await cauldron.addCodePushEntry(
      napDescriptor, {
        deploymentName: deploymentName,
        isMandatory: codePushResponse.isMandatory,
        appVersion: codePushResponse.appVersion,
        size: codePushResponse.size,
        releaseMethod: codePushResponse.releaseMethod,
        label: codePushResponse.label,
        releasedBy: codePushResponse.releasedBy,
        rollout: codePushResponse.rollout
      },
      miniAppsToBeCodePushed,
      jsApiImplsToBeCodePushed)

    const pathToNewYarnLock = path.join(tmpWorkingDir, 'yarn.lock')
    await spin(`Adding yarn.lock to Cauldron`, cauldron.addOrUpdateYarnLock(napDescriptor, deploymentName, pathToNewYarnLock))
    await cauldron.commitTransaction(`CodePush release for ${napDescriptor.toString()} ${deploymentName}`)
  } catch (e) {
    if (cauldron) {
      await cauldron.discardTransaction()
    }
    log.error(`performCodePushOtaUpdate {e}`)
    throw e
  }
}

async function areMiniAppsNativeDependenciesAlignedWithTargetApplicationVersion (
  miniApps: Array<PackagePath>,
  targetDescriptor: NativeApplicationDescriptor) : Promise<boolean> {
  for (const miniApp of miniApps) {
    let miniAppInstance = await spin(`Checking native dependencies version alignment of ${miniApp.toString()} with ${targetDescriptor.toString()}`,
      MiniApp.fromPackagePath(new PackagePath(miniApp.toString())))
    let report = await compatibility.checkCompatibilityWithNativeApp(
          miniAppInstance,
          targetDescriptor.name,
          targetDescriptor.platform,
          targetDescriptor.version)
    if (!report.isCompatible) {
      log.warn('At least one native dependency version is not aligned !')
      return false
    } else {
      log.info(`${miniApp.toString()} native dependencies versions are aligned with ${targetDescriptor.toString()}`)
    }
  }
  return true
}

export async function getCodePushTargetVersionName (
  napDescriptor: NativeApplicationDescriptor,
  deploymentName: string) {
  if (!napDescriptor.version) {
    throw new Error(`Native application descriptor ${napDescriptor.toString()} does not contain a version !`)
  }
  let result = napDescriptor.version
  const cauldron = await coreUtils.getCauldronInstance()
  const codePushConfig = await cauldron.getCodePushConfig(napDescriptor.withoutVersion())
  if (codePushConfig && codePushConfig.versionModifiers) {
    const versionModifier = _.find(codePushConfig.versionModifiers, m => m.deploymentName === deploymentName)
    if (versionModifier) {
      result = result.replace(/(.+)/, versionModifier.modifier)
    }
  }
  return result
}

async function getCodePushAppName (
  napDescriptor: NativeApplicationDescriptor) : Promise<string> {
  let result = napDescriptor.name
  const cauldron = await coreUtils.getCauldronInstance()
  const codePushConfig = await cauldron.getCodePushConfig(napDescriptor.withoutVersion())
  if (codePushConfig && codePushConfig.appName) {
    result = codePushConfig.appName
  } else {
    result = `${napDescriptor.name}${napDescriptor.platform === 'ios' ? 'Ios' : 'Android'}`
  }
  return result
}

export function getCodePushAccessKey () {
  let codePushAccessKey = config.getValue('codePushAccessKey')
  if (!codePushAccessKey) {
    const codePushConfigFilePath = path.join(process.env.LOCALAPPDATA || process.env.HOME || '', '.code-push.config')
    if (fs.existsSync(codePushConfigFilePath)) {
      codePushAccessKey = JSON.parse(fs.readFileSync(codePushConfigFilePath, 'utf-8')).accessKey
    }
  }
  return codePushAccessKey
}

export function getCodePushSdk () {
  const codePushAccessKey = getCodePushAccessKey()
  if (!codePushAccessKey) {
    throw new Error('Unable to get the CodePush access key to use')
  }
  return new CodePushSdk(codePushAccessKey)
}

async function askUserToConfirmCodePushPublication (
  miniAppsToBeCodePushed: Array<PackagePath>,
  jsApiImplsToBeCodePushed: Array<PackagePath>) : Promise<boolean> {
  if (miniAppsToBeCodePushed && miniAppsToBeCodePushed.length > 0) {
    log.info(`The following MiniApp versions will get shipped in this CodePush OTA update :`)
    miniAppsToBeCodePushed.forEach(m => log.info(m.toString()))
  }
  if (jsApiImplsToBeCodePushed && jsApiImplsToBeCodePushed.length > 0) {
    log.info(`The following JS API implementation versions will get shipped in this CodePush OTA update :`)
    jsApiImplsToBeCodePushed.forEach(m => log.info(m.toString()))
  }

  const { userCodePushPublicationConfirmation } = await inquirer.prompt({
    type: 'confirm',
    name: 'userCodePushPublicationConfirmation',
    message: 'Do you want to continue with CodePush publication ?'
  })

  return userCodePushPublicationConfirmation
}

async function askUserToForceCodePushPublication () : Promise<boolean> {
  const { userCodePushForcePublication } = await inquirer.prompt({
    type: 'confirm',
    name: 'userCodePushForcePublication',
    message: 'At least one native dependency version is not properly aligned. Do you want to force CodePush anyway ?'
  })

  return userCodePushForcePublication
}

export async function askUserForCodePushDeploymentName (napDescriptor: NativeApplicationDescriptor, message?: string) : Promise<string> {
  const cauldron = await coreUtils.getCauldronInstance()
  const config = await cauldron.getConfig(napDescriptor)
  const hasCodePushDeploymentsConfig = config && config.codePush && config.codePush.deployments
  const choices = hasCodePushDeploymentsConfig ? config && config.codePush.deployments : undefined

  const { userSelectedDeploymentName } = await inquirer.prompt({
    type: choices ? 'list' : 'input',
    name: 'userSelectedDeploymentName',
    message: message || 'Deployment name',
    choices
  })

  return userSelectedDeploymentName
}
