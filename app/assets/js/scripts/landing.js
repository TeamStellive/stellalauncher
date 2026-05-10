/**
 * Script for landing.ejs
 */
// Requirements
const neoForgeChildProcess     = require('child_process')
const neoForgeFS               = require('fs-extra')
const got                      = require('got')
const nodePath                = require('path')
const { URL }                 = require('url')
const { Type: LandingDistroType } = require('helios-distribution-types')
const {
    MojangRestAPI,
    getServerStatus
}                             = require('helios-core/mojang')
const {
    RestResponseStatus,
    isDisplayableError,
    validateLocalFile,
    getMojangOS,
    isLibraryCompatible,
    MavenUtil
}                             = require('helios-core/common')
const {
    FullRepair,
    DistributionIndexProcessor,
    MojangIndexProcessor,
    HashAlgo,
    downloadFile,
    downloadQueue,
    getExpectedDownloadSize
}                             = require('helios-core/dl')
const {
    validateSelectedJvm,
    ensureJavaDirIsRoot,
    javaExecFromRoot,
    discoverBestJvmInstallation,
    latestOpenJDK,
    extractJdk
}                             = require('helios-core/java')

// Internal Requirements
const LandingAuthManager      = require('./assets/js/authmanager')
const DiscordWrapper          = require('./assets/js/discordwrapper')
const LandingDropinModUtil    = require('./assets/js/dropinmodutil')
const ProcessBuilder          = require('./assets/js/processbuilder')

// Launch Elements
const launch_content          = document.getElementById('launch_content')
const launch_details          = document.getElementById('launch_details')
const launch_progress         = document.getElementById('launch_progress')
const launch_progress_label   = document.getElementById('launch_progress_label')
const launch_details_text     = document.getElementById('launch_details_text')
const server_selection_button = document.getElementById('server_selection_button')
const user_text               = document.getElementById('user_text')

const loggerLanding = LoggerUtil.getLogger('Landing')

/* Launch Progress Wrapper Functions */

/**
 * Show/hide the loading area.
 *
 * @param {boolean} loading True if the loading area should be shown, otherwise false.
 */
function toggleLaunchArea(loading){
    if(loading){
        launch_details.style.display = 'flex'
        launch_content.style.display = 'none'
    } else {
        launch_details.style.display = 'none'
        launch_content.style.display = 'inline-flex'
    }
}

/**
 * Set the details text of the loading area.
 *
 * @param {string} details The new text for the loading details.
 */
function setLaunchDetails(details){
    launch_details_text.innerHTML = details
}

/**
 * Set the value of the loading progress bar and display that value.
 *
 * @param {number} percent Percentage (0-100)
 */
function setLaunchPercentage(percent){
    launch_progress.setAttribute('max', 100)
    launch_progress.setAttribute('value', percent)
    launch_progress_label.innerHTML = percent + '%'
}

/**
 * Set the value of the OS progress bar and display that on the UI.
 *
 * @param {number} percent Percentage (0-100)
 */
function setDownloadPercentage(percent){
    remote.getCurrentWindow().setProgressBar(percent/100)
    setLaunchPercentage(percent)
}

/**
 * Enable or disable the launch button.
 *
 * @param {boolean} val True to enable, false to disable.
 */
function setLaunchEnabled(val){
    document.getElementById('launch_button').disabled = !val
}

// Bind launch button
document.getElementById('launch_button').addEventListener('click', async e => {
    loggerLanding.info('Launching game..')
    try {
        const server = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())
        const jExe = ConfigManager.getJavaExecutable(ConfigManager.getSelectedServer())
        if(jExe == null){
            await asyncSystemScan(server.effectiveJavaOptions)
        } else {

            setLaunchDetails(Lang.queryJS('landing.launch.pleaseWait'))
            toggleLaunchArea(true)
            setLaunchPercentage(0, 100)

            const details = await validateSelectedJvm(ensureJavaDirIsRoot(jExe), server.effectiveJavaOptions.supported)
            if(details != null){
                loggerLanding.info('Jvm Details', details)
                await dlAsync()

            } else {
                await asyncSystemScan(server.effectiveJavaOptions)
            }
        }
    } catch(err) {
        loggerLanding.error('Unhandled error in during launch process.', err)
        showLaunchFailure(Lang.queryJS('landing.launch.failureTitle'), Lang.queryJS('landing.launch.failureText'))
    }
})

// Bind settings button
document.getElementById('settingsMediaButton').onclick = async e => {
    await prepareSettings()
    switchView(getCurrentView(), VIEWS.settings)
}

// Bind avatar overlay button.
document.getElementById('avatarOverlay').onclick = async e => {
    await prepareSettings()
    switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {
        settingsNavItemListener(document.getElementById('settingsNavAccount'), false)
    })
}

// Bind selected account
function updateSelectedAccount(authUser){
    let username = Lang.queryJS('landing.selectedAccount.noAccountSelected')
    if(authUser != null){
        if(authUser.displayName != null){
            username = authUser.displayName
        }
        if(authUser.uuid != null){
            document.getElementById('avatarContainer').style.backgroundImage = `url('https://mc-heads.net/body/${authUser.uuid}/right')`
        }
    }
    user_text.innerHTML = username
}
updateSelectedAccount(ConfigManager.getSelectedAccount())

// Bind selected server
function updateSelectedServer(serv){
    if(getCurrentView() === VIEWS.settings){
        fullSettingsSave()
    }
    ConfigManager.setSelectedServer(serv != null ? serv.rawServer.id : null)
    ConfigManager.save()
    server_selection_button.innerHTML = '&#8226; ' + (serv != null ? serv.rawServer.name : Lang.queryJS('landing.noSelection'))
    if(getCurrentView() === VIEWS.settings){
        animateSettingsTabRefresh()
    }
    setLaunchEnabled(serv != null)
}
// Real text is set in uibinder.js on distributionIndexDone.
server_selection_button.innerHTML = '&#8226; ' + Lang.queryJS('landing.selectedServer.loading')
server_selection_button.onclick = async e => {
    e.target.blur()
    await toggleServerSelection(true)
}

// Update Mojang Status Color
const refreshMojangStatuses = async function(){
    loggerLanding.info('Refreshing Mojang Statuses..')

    let status = 'grey'
    let tooltipEssentialHTML = ''
    let tooltipNonEssentialHTML = ''

    const response = await MojangRestAPI.status()
    let statuses
    if(response.responseStatus === RestResponseStatus.SUCCESS) {
        statuses = response.data
    } else {
        loggerLanding.warn('Unable to refresh Mojang service status.')
        statuses = MojangRestAPI.getDefaultStatuses()
    }

    greenCount = 0
    greyCount = 0

    for(let i=0; i<statuses.length; i++){
        const service = statuses[i]

        const tooltipHTML = `<div class="mojangStatusContainer">
            <span class="mojangStatusIcon" style="color: ${MojangRestAPI.statusToHex(service.status)};">&#8226;</span>
            <span class="mojangStatusName">${service.name}</span>
        </div>`
        if(service.essential){
            tooltipEssentialHTML += tooltipHTML
        } else {
            tooltipNonEssentialHTML += tooltipHTML
        }

        if(service.status === 'yellow' && status !== 'red'){
            status = 'yellow'
        } else if(service.status === 'red'){
            status = 'red'
        } else {
            if(service.status === 'grey'){
                ++greyCount
            }
            ++greenCount
        }

    }

    if(greenCount === statuses.length){
        if(greyCount === statuses.length){
            status = 'grey'
        } else {
            status = 'green'
        }
    }

    document.getElementById('mojangStatusEssentialContainer').innerHTML = tooltipEssentialHTML
    document.getElementById('mojangStatusNonEssentialContainer').innerHTML = tooltipNonEssentialHTML
    document.getElementById('mojang_status_icon').style.color = MojangRestAPI.statusToHex(status)
}

async function refreshServerStatus(fade = false) {
    loggerLanding.info('Refreshing Server Status')
    const serv = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())

    let pLabel = Lang.queryJS('landing.serverStatus.server')
    let pVal = Lang.queryJS('landing.serverStatus.offline')

    try {

        const servStat = await getServerStatus(47, serv.hostname, serv.port)
        console.log(servStat)
        pLabel = Lang.queryJS('landing.serverStatus.players')
        pVal = servStat.players.online + '/' + servStat.players.max

    } catch (err) {
        loggerLanding.warn('Unable to refresh server status, assuming offline.')
        loggerLanding.debug(err)
    }
    if(fade){
        $('#server_status_wrapper').fadeOut(250, () => {
            document.getElementById('landingPlayerLabel').innerHTML = pLabel
            document.getElementById('player_count').innerHTML = pVal
            $('#server_status_wrapper').fadeIn(500)
        })
    } else {
        document.getElementById('landingPlayerLabel').innerHTML = pLabel
        document.getElementById('player_count').innerHTML = pVal
    }

}

refreshMojangStatuses()
// Server Status is refreshed in uibinder.js on distributionIndexDone.

// Refresh statuses every hour. The status page itself refreshes every day so...
let mojangStatusListener = setInterval(() => refreshMojangStatuses(true), 60*60*1000)
// Set refresh rate to once every 5 minutes.
let serverStatusListener = setInterval(() => refreshServerStatus(true), 300000)

/**
 * Shows an error overlay, toggles off the launch area.
 *
 * @param {string} title The overlay title.
 * @param {string} desc The overlay description.
 */
function showLaunchFailure(title, desc){
    setOverlayContent(
        title,
        desc,
        Lang.queryJS('landing.launch.okay')
    )
    setOverlayHandler(null)
    toggleOverlay(true)
    toggleLaunchArea(false)
}

/* System (Java) Scan */

/**
 * Asynchronously scan the system for valid Java installations.
 *
 * @param {boolean} launchAfter Whether we should begin to launch after scanning.
 */
async function asyncSystemScan(effectiveJavaOptions, launchAfter = true){

    setLaunchDetails(Lang.queryJS('landing.systemScan.checking'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    const jvmDetails = await discoverBestJvmInstallation(
        ConfigManager.getDataDirectory(),
        effectiveJavaOptions.supported
    )

    if(jvmDetails == null) {
        // If the result is null, no valid Java installation was found.
        // Show this information to the user.
        setOverlayContent(
            Lang.queryJS('landing.systemScan.noCompatibleJava'),
            Lang.queryJS('landing.systemScan.installJavaMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
            Lang.queryJS('landing.systemScan.installJava'),
            Lang.queryJS('landing.systemScan.installJavaManually')
        )
        setOverlayHandler(() => {
            setLaunchDetails(Lang.queryJS('landing.systemScan.javaDownloadPrepare'))
            toggleOverlay(false)

            try {
                downloadJava(effectiveJavaOptions, launchAfter)
            } catch(err) {
                loggerLanding.error('Unhandled error in Java Download', err)
                showLaunchFailure(Lang.queryJS('landing.systemScan.javaDownloadFailureTitle'), Lang.queryJS('landing.systemScan.javaDownloadFailureText'))
            }
        })
        setDismissHandler(() => {
            $('#overlayContent').fadeOut(250, () => {
                //$('#overlayDismiss').toggle(false)
                setOverlayContent(
                    Lang.queryJS('landing.systemScan.javaRequired', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredDismiss'),
                    Lang.queryJS('landing.systemScan.javaRequiredCancel')
                )
                setOverlayHandler(() => {
                    toggleLaunchArea(false)
                    toggleOverlay(false)
                })
                setDismissHandler(() => {
                    toggleOverlay(false, true)

                    asyncSystemScan(effectiveJavaOptions, launchAfter)
                })
                $('#overlayContent').fadeIn(250)
            })
        })
        toggleOverlay(true, true)
    } else {
        // Java installation found, use this to launch the game.
        const javaExec = javaExecFromRoot(jvmDetails.path)
        ConfigManager.setJavaExecutable(ConfigManager.getSelectedServer(), javaExec)
        ConfigManager.save()

        // We need to make sure that the updated value is on the settings UI.
        // Just incase the settings UI is already open.
        settingsJavaExecVal.value = javaExec
        await populateJavaExecDetails(settingsJavaExecVal.value)

        // TODO Callback hell, refactor
        // TODO Move this out, separate concerns.
        if(launchAfter){
            await dlAsync()
        }
    }

}

async function downloadJava(effectiveJavaOptions, launchAfter = true) {

    // TODO Error handling.
    // asset can be null.
    const asset = await latestOpenJDK(
        effectiveJavaOptions.suggestedMajor,
        ConfigManager.getDataDirectory(),
        effectiveJavaOptions.distribution)

    if(asset == null) {
        throw new Error(Lang.queryJS('landing.downloadJava.findJdkFailure'))
    }

    let received = 0
    await downloadFile(asset.url, asset.path, ({ transferred }) => {
        received = transferred
        setDownloadPercentage(Math.trunc((transferred/asset.size)*100))
    })
    setDownloadPercentage(100)

    if(received != asset.size) {
        loggerLanding.warn(`Java Download: Expected ${asset.size} bytes but received ${received}`)
        if(!await validateLocalFile(asset.path, asset.algo, asset.hash)) {
            log.error(`Hashes do not match, ${asset.id} may be corrupted.`)
            // Don't know how this could happen, but report it.
            throw new Error(Lang.queryJS('landing.downloadJava.javaDownloadCorruptedError'))
        }
    }

    // Extract
    // Show installing progress bar.
    remote.getCurrentWindow().setProgressBar(2)

    // Wait for extration to complete.
    const eLStr = Lang.queryJS('landing.downloadJava.extractingJava')
    let dotStr = ''
    setLaunchDetails(eLStr)
    const extractListener = setInterval(() => {
        if(dotStr.length >= 3){
            dotStr = ''
        } else {
            dotStr += '.'
        }
        setLaunchDetails(eLStr + dotStr)
    }, 750)

    const newJavaExec = await extractJdk(asset.path)

    // Extraction complete, remove the loading from the OS progress bar.
    remote.getCurrentWindow().setProgressBar(-1)

    // Extraction completed successfully.
    ConfigManager.setJavaExecutable(ConfigManager.getSelectedServer(), newJavaExec)
    ConfigManager.save()

    clearInterval(extractListener)
    setLaunchDetails(Lang.queryJS('landing.downloadJava.javaInstalled'))

    // TODO Callback hell
    // Refactor the launch functions
    asyncSystemScan(effectiveJavaOptions, launchAfter)

}

function resolveLibraryArtifact(libEntry) {
    if(!isLibraryCompatible(libEntry.rules, libEntry.natives)){
        return null
    }

    if(libEntry.natives == null){
        return libEntry.downloads?.artifact ?? resolveMavenLibraryArtifact(libEntry)
    }

    const classifierTemplate = libEntry.natives[getMojangOS()]
    if(classifierTemplate == null){
        return null
    }

    const classifier = classifierTemplate.replace('${arch}', process.arch.replace('x', ''))
    return libEntry.downloads?.classifiers?.[classifier] ?? null
}

function resolveMavenLibraryArtifact(libEntry) {
    if(libEntry?.name == null || libEntry?.url == null){
        return null
    }

    const baseUrl = libEntry.url.endsWith('/') ? libEntry.url : `${libEntry.url}/`
    const artifactPath = MavenUtil.mavenIdentifierAsPath(libEntry.name)
    return {
        path: artifactPath,
        url: new URL(artifactPath, baseUrl).toString(),
        sha1: libEntry.sha1,
        size: libEntry.size
    }
}

async function validateModLoaderLibraries(modLoaderData) {
    const notValid = []
    const libDir = nodePath.join(ConfigManager.getCommonDirectory(), 'libraries')

    for(const libEntry of modLoaderData.libraries ?? []){
        const artifact = resolveLibraryArtifact(libEntry)
        if(artifact?.path == null || artifact?.url == null){
            continue
        }

        const libPath = nodePath.join(libDir, artifact.path)
        if(!await validateLocalFile(libPath, HashAlgo.SHA1, artifact.sha1)){
            notValid.push({
                id: libEntry.name,
                hash: artifact.sha1,
                algo: HashAlgo.SHA1,
                size: artifact.size ?? 0,
                url: artifact.url,
                path: libPath
            })
        }
    }

    return notValid
}

async function ensureModLoaderLibraries(modLoaderData, loggerLaunchSuite) {
    const invalidLibraries = await validateModLoaderLibraries(modLoaderData)
    if(invalidLibraries.length === 0){
        return
    }

    loggerLaunchSuite.info(`Downloading ${invalidLibraries.length} mod loader libraries.`)
    setLaunchDetails(Lang.queryJS('landing.dlAsync.downloadingFiles'))
    setDownloadPercentage(0)

    const expectedTotalSize = getExpectedDownloadSize(invalidLibraries)
    await downloadQueue(invalidLibraries, received => {
        const percent = expectedTotalSize > 0 ? Math.trunc((received / expectedTotalSize) * 100) : 0
        setDownloadPercentage(percent)
    })
    setDownloadPercentage(100)

    for(const asset of invalidLibraries){
        if(!await validateLocalFile(asset.path, asset.algo, asset.hash)){
            throw new Error(`Downloaded mod loader library failed validation: ${asset.id}`)
        }
    }
}

function resolveNeoForgeVersion(modLoaderData) {
    const argVersion = resolveModLoaderGameArg(modLoaderData, '--fml.neoForgeVersion')
    if(argVersion != null){
        return argVersion
    }

    const idMatch = `${modLoaderData?.id ?? ''}`.match(/^neoforge-(.+)$/i)
    return idMatch?.[1] ?? null
}

function resolveModLoaderGameArg(modLoaderData, argName) {
    const gameArgs = modLoaderData?.arguments?.game ?? []
    for(let i=0; i<gameArgs.length - 1; i++){
        if(gameArgs[i] === argName && typeof gameArgs[i + 1] === 'string'){
            return gameArgs[i + 1]
        }
    }

    return null
}

function resolveNeoForgeMinecraftArtifactVersion(modLoaderData) {
    const mcVersion = resolveModLoaderGameArg(modLoaderData, '--fml.mcVersion')
    const neoFormVersion = resolveModLoaderGameArg(modLoaderData, '--fml.neoFormVersion')
    return mcVersion != null && neoFormVersion != null ? `${mcVersion}-${neoFormVersion}` : null
}

function resolveNeoForgeRuntimePaths(version, modLoaderData) {
    const baseDir = nodePath.join(ConfigManager.getCommonDirectory(), 'libraries', 'net', 'neoforged', 'neoforge', version)
    const paths = {
        installer: nodePath.join(baseDir, `neoforge-${version}.jar`),
        client: nodePath.join(baseDir, `neoforge-${version}-client.jar`),
        universal: nodePath.join(baseDir, `neoforge-${version}-universal.jar`)
    }

    const minecraftArtifactVersion = resolveNeoForgeMinecraftArtifactVersion(modLoaderData)
    if(minecraftArtifactVersion != null){
        const minecraftClientDir = nodePath.join(ConfigManager.getCommonDirectory(), 'libraries', 'net', 'minecraft', 'client', minecraftArtifactVersion)
        paths.minecraftSrg = nodePath.join(minecraftClientDir, `client-${minecraftArtifactVersion}-srg.jar`)
        paths.minecraftExtra = nodePath.join(minecraftClientDir, `client-${minecraftArtifactVersion}-extra.jar`)
    }

    return paths
}

async function ensureNeoForgeLauncherProfiles(commonDir) {
    const launcherProfilesPath = nodePath.join(commonDir, 'launcher_profiles.json')
    if(await neoForgeFS.pathExists(launcherProfilesPath)){
        return
    }

    await neoForgeFS.writeJson(launcherProfilesPath, { profiles: {}, version: 3 })
}

function runNeoForgeInstaller(javaExec, installerPath, commonDir, loggerLaunchSuite) {
    return new Promise((resolve, reject) => {
        const child = neoForgeChildProcess.spawn(javaExec, ['-jar', installerPath, '--installClient', commonDir], {
            cwd: commonDir
        })

        const errLines = []

        child.stdout.on('data', data => {
            data.toString().trim().split(/\r?\n/).filter(Boolean).forEach(line => {
                loggerLaunchSuite.info(`[NeoForge Installer] ${line}`)
            })
        })

        child.stderr.on('data', data => {
            data.toString().trim().split(/\r?\n/).filter(Boolean).forEach(line => {
                errLines.push(line)
                loggerLaunchSuite.warn(`[NeoForge Installer] ${line}`)
            })
        })

        child.on('error', reject)
        child.on('close', code => {
            if(code === 0){
                resolve()
            } else {
                reject(new Error(`NeoForge installer exited with code ${code}. ${errLines.slice(-5).join(' ')}`.trim()))
            }
        })
    })
}

async function ensureNeoForgeClientInstall(modLoaderData, serv, loggerLaunchSuite) {
    const neoForgeVersion = resolveNeoForgeVersion(modLoaderData)
    if(neoForgeVersion == null){
        return
    }

    const commonDir = ConfigManager.getCommonDirectory()
    const paths = resolveNeoForgeRuntimePaths(neoForgeVersion, modLoaderData)
    const requiredRuntimePaths = [
        paths.client,
        paths.universal,
        paths.minecraftSrg,
        paths.minecraftExtra
    ].filter(Boolean)

    if((await Promise.all(requiredRuntimePaths.map(path => neoForgeFS.pathExists(path)))).every(Boolean)){
        return
    }

    if(!await neoForgeFS.pathExists(paths.installer)){
        throw new Error(`NeoForge installer jar is missing: ${paths.installer}`)
    }

    loggerLaunchSuite.info(`Preparing NeoForge runtime artifacts for ${neoForgeVersion}.`)
    setLaunchDetails(Lang.queryJS('landing.dlAsync.preparingToLaunch'))

    await ensureNeoForgeLauncherProfiles(commonDir)
    await runNeoForgeInstaller(ConfigManager.getJavaExecutable(serv.rawServer.id) || 'java', paths.installer, commonDir, loggerLaunchSuite)

    if(!(await Promise.all(requiredRuntimePaths.map(path => neoForgeFS.pathExists(path)))).every(Boolean)){
        throw new Error(`NeoForge installer did not generate required runtime jars for ${neoForgeVersion}.`)
    }
}

// Keep reference to Minecraft Process
let proc
// Is DiscordRPC enabled
let hasRPC = false
// Joined server regex
// Change this if your server uses something different.
const GAME_JOINED_REGEX = /\[.+\]: Sound engine started/
const SERVER_JOINED_REGEXES = [
    /\[.+\]: Loaded \d+ advancements/
]
const SERVER_CONNECTING_REGEX = /\[.+\]: Connecting to .+/
const SERVER_DISCONNECTED_REGEX = /\[.+\]: (?:Disconnecting from server|Failed to connect to server|Connection refused|Timed out)/
const GAME_LAUNCH_REGEX = /^\[.+\]: (?:MinecraftForge .+ Initialized|ModLauncher .+ starting: .+|Loading Minecraft .+ with Fabric Loader .+)$/
const MIN_LINGER = 5000
const RPC_JOIN_FALLBACK_DELAY = 30000
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const MODRINTH_API_BASE = 'https://api.modrinth.com/v2'
const MANAGED_SHADER_FILE_PREFIX = 'stella-managed-modrinth-'
const MANAGED_SHADER_MANIFEST = '.stella-shader-loader.json'
const MANAGED_SHADER_DISABLED_EXT = '.disabled'
const SHADER_LOADER_OPTIONS = {
    iris: {
        label: 'Iris',
        project: 'iris'
    },
    optifine: {
        label: 'OptiFine',
        project: 'optifine'
    }
}
const MODRINTH_DEPENDENCY_HINTS = {
    // Sodium is the required Modrinth dependency for Iris and is already shipped
    // by some Stella server distributions.
    AANobbMI: ['sodium']
}

function getServerInstanceDir(serv) {
    return nodePath.join(ConfigManager.getInstanceDirectory(), serv.rawServer.id)
}

function getServerModsDir(serv) {
    return nodePath.join(getServerInstanceDir(serv), 'mods')
}

function getModrinthUserAgent() {
    let launcherVersion = 'unknown'
    try {
        if(typeof remote !== 'undefined' && remote?.app?.getVersion != null) {
            launcherVersion = remote.app.getVersion()
        }
    } catch(_err) {
        // Keep the fallback version.
    }
    return `StellaLauncher/${launcherVersion} (https://github.com/TeamStellive/stellalauncher)`
}

function getModrinthUrl(endpoint, query = {}) {
    const url = new URL(endpoint.startsWith('/') ? `${MODRINTH_API_BASE}${endpoint}` : `${MODRINTH_API_BASE}/${endpoint}`)
    for(const [key, value] of Object.entries(query)) {
        if(value != null) {
            url.searchParams.set(key, value)
        }
    }
    return url.toString()
}

async function modrinthGet(endpoint, query = {}) {
    return got(getModrinthUrl(endpoint, query), {
        headers: {
            'Accept': 'application/json',
            'User-Agent': getModrinthUserAgent()
        },
        timeout: {
            request: 15000
        }
    }).json()
}

function getModrinthVersionQuery(minecraftVersion, loader) {
    return {
        game_versions: JSON.stringify([minecraftVersion]),
        loaders: JSON.stringify([loader])
    }
}

function getPrimaryModrinthFile(version) {
    return version?.files?.find(file => file.primary) ?? version?.files?.[0] ?? null
}

function sanitizeManagedFileName(fileName) {
    return fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
}

function getManagedFileName(projectId, versionId, fileName) {
    return sanitizeManagedFileName(`${MANAGED_SHADER_FILE_PREFIX}${projectId}-${versionId}-${fileName}`)
}

function getManagedManifestPath(modsDir) {
    return nodePath.join(modsDir, MANAGED_SHADER_MANIFEST)
}

function readManagedShaderManifest(modsDir) {
    const manifestPath = getManagedManifestPath(modsDir)
    if(!neoForgeFS.existsSync(manifestPath)) {
        return null
    }
    try {
        return JSON.parse(neoForgeFS.readFileSync(manifestPath, 'UTF-8'))
    } catch(err) {
        loggerLanding.warn('Unable to read managed shader loader manifest.', err)
        return null
    }
}

async function isManagedShaderManifestCurrent(modsDir, choice, minecraftVersion, loader) {
    const manifest = readManagedShaderManifest(modsDir)
    if(manifest == null || manifest.choice !== choice || manifest.minecraftVersion !== minecraftVersion || manifest.loader !== loader) {
        return false
    }
    if(!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
        return false
    }
    for(const entry of manifest.entries) {
        if(entry.localName == null || entry.sha1 == null) {
            return false
        }
        const localPath = nodePath.join(modsDir, entry.localName)
        const disabledPath = `${localPath}${MANAGED_SHADER_DISABLED_EXT}`
        const validationPath = neoForgeFS.existsSync(localPath) ? localPath : disabledPath
        if(!await validateLocalFile(validationPath, HashAlgo.SHA1, entry.sha1)) {
            return false
        }
    }
    return true
}

function doesManagedManifestMatchPlan(modsDir, choice, minecraftVersion, loader, entries) {
    const manifest = readManagedShaderManifest(modsDir)
    if(manifest == null || manifest.choice !== choice || manifest.minecraftVersion !== minecraftVersion || manifest.loader !== loader) {
        return false
    }
    if(!Array.isArray(manifest.entries) || manifest.entries.length !== entries.length) {
        return false
    }

    return entries.every(entry => manifest.entries.some(manifestEntry =>
        manifestEntry.projectId === entry.projectId
        && manifestEntry.versionId === entry.versionId
        && manifestEntry.localName === entry.localName
        && manifestEntry.sha1 === entry.sha1
    ))
}

function setManagedShaderLoaderEnabled(modsDir, enabled) {
    if(!neoForgeFS.existsSync(modsDir)) {
        return
    }

    const manifest = readManagedShaderManifest(modsDir)
    const localNames = Array.isArray(manifest?.entries)
        ? manifest.entries.map(entry => entry.localName).filter(Boolean)
        : neoForgeFS.readdirSync(modsDir).filter(fileName => fileName.startsWith(MANAGED_SHADER_FILE_PREFIX))

    for(const localName of localNames) {
        const baseName = localName.endsWith(MANAGED_SHADER_DISABLED_EXT)
            ? localName.substring(0, localName.length - MANAGED_SHADER_DISABLED_EXT.length)
            : localName
        const enabledPath = nodePath.join(modsDir, baseName)
        const disabledPath = `${enabledPath}${MANAGED_SHADER_DISABLED_EXT}`

        if(enabled) {
            if(neoForgeFS.existsSync(disabledPath)) {
                if(neoForgeFS.existsSync(enabledPath)) {
                    neoForgeFS.removeSync(disabledPath)
                } else {
                    neoForgeFS.renameSync(disabledPath, enabledPath)
                }
            }
        } else if(neoForgeFS.existsSync(enabledPath)) {
            if(neoForgeFS.existsSync(disabledPath)) {
                neoForgeFS.removeSync(enabledPath)
            } else {
                neoForgeFS.renameSync(enabledPath, disabledPath)
            }
        }
    }
}

function cleanupManagedShaderLoader(modsDir) {
    if(!neoForgeFS.existsSync(modsDir)) {
        return
    }
    for(const fileName of neoForgeFS.readdirSync(modsDir)) {
        if(fileName.startsWith(MANAGED_SHADER_FILE_PREFIX)) {
            neoForgeFS.removeSync(nodePath.join(modsDir, fileName))
        }
    }
    neoForgeFS.removeSync(getManagedManifestPath(modsDir))
}

function writeManagedShaderManifest(modsDir, choice, minecraftVersion, loader, entries) {
    neoForgeFS.writeFileSync(
        getManagedManifestPath(modsDir),
        JSON.stringify({
            choice,
            minecraftVersion,
            loader,
            updatedAt: new Date().toISOString(),
            entries
        }, null, 4),
        'UTF-8'
    )
}

function safeGetVersionlessMavenIdentifier(mdl) {
    if(typeof mdl.getVersionlessMavenIdentifier !== 'function') {
        return null
    }
    try {
        return mdl.getVersionlessMavenIdentifier()
    } catch(_err) {
        return null
    }
}

function safeGetRequired(mdl) {
    if(typeof mdl.getRequired !== 'function') {
        return null
    }
    try {
        return mdl.getRequired()
    } catch(_err) {
        return null
    }
}

function moduleHasOwnHint(mdl, hints) {
    const raw = mdl.rawModule ?? {}
    const haystack = [
        raw.id,
        raw.name,
        raw.artifact?.url,
        safeGetVersionlessMavenIdentifier(mdl)
    ].filter(Boolean).join(' ').toLowerCase()

    return hints.some(hint => haystack.includes(hint))
}

function isModuleEnabledForLaunch(mdl, modCfg) {
    const mdlId = safeGetVersionlessMavenIdentifier(mdl)
    const required = safeGetRequired(mdl)
    return ProcessBuilder.isModEnabled(mdlId != null ? modCfg?.[mdlId] : null, required)
}

function isKnownDependencyProvidedByDistribution(projectId, serv) {
    const hints = MODRINTH_DEPENDENCY_HINTS[projectId]
    if(hints == null) {
        return false
    }
    const modCfg = ConfigManager.getModConfiguration(serv.rawServer.id)?.mods ?? {}
    return serv.modules.some(mdl => isActiveDistributionModuleWithHint(mdl, hints, modCfg))
}

function isActiveDistributionModuleWithHint(mdl, hints, modCfg) {
    if(!isModuleEnabledForLaunch(mdl, modCfg)) {
        return false
    }

    if(moduleHasOwnHint(mdl, hints)) {
        return true
    }

    const mdlId = safeGetVersionlessMavenIdentifier(mdl)
    const childCfg = mdlId != null ? modCfg?.[mdlId]?.mods ?? {} : modCfg
    return (mdl.subModules ?? []).some(subModule => isActiveDistributionModuleWithHint(subModule, hints, childCfg))
}

function resolveServerModrinthLoader(serv) {
    if(serv.modules.some(mdl => mdl.rawModule.type === LandingDistroType.Fabric)) {
        return 'fabric'
    }

    const forgeHosted = serv.modules.find(mdl => mdl.rawModule.type === LandingDistroType.ForgeHosted)
    if(forgeHosted != null) {
        const raw = forgeHosted.rawModule ?? {}
        const identity = [
            raw.id,
            raw.name,
            safeGetVersionlessMavenIdentifier(forgeHosted)
        ].filter(Boolean).join(' ').toLowerCase()
        return identity.includes('neoforge') || identity.includes('neoforged') ? 'neoforge' : 'forge'
    }

    return null
}

async function resolveModrinthProjectVersion(project, displayName, minecraftVersion, loader) {
    let versions
    try {
        versions = await modrinthGet(`/project/${encodeURIComponent(project)}/version`, getModrinthVersionQuery(minecraftVersion, loader))
    } catch(err) {
        if(err.response?.statusCode === 404) {
            throw new Error(Lang.queryJS('landing.shaderLoader.projectNotFound', { name: displayName }))
        }
        throw err
    }

    if(!Array.isArray(versions) || versions.length === 0) {
        throw new Error(Lang.queryJS('landing.shaderLoader.noCompatibleVersion', {
            name: displayName,
            minecraftVersion,
            loader
        }))
    }

    return versions.find(version => version.version_type === 'release' && getPrimaryModrinthFile(version) != null)
        ?? versions.find(version => getPrimaryModrinthFile(version) != null)
        ?? versions[0]
}

async function resolveModrinthVersionForInstall(ref, minecraftVersion, loader) {
    if(ref.versionId != null) {
        return modrinthGet(`/version/${encodeURIComponent(ref.versionId)}`)
    }

    return resolveModrinthProjectVersion(ref.project, ref.displayName, minecraftVersion, loader)
}

async function collectModrinthInstallPlan(ref, serv, minecraftVersion, loader, state) {
    const version = await resolveModrinthVersionForInstall(ref, minecraftVersion, loader)
    if(state.seenVersions.has(version.id)) {
        return
    }
    state.seenVersions.add(version.id)

    for(const dependency of version.dependencies ?? []) {
        if(dependency.dependency_type !== 'required') {
            continue
        }
        if(dependency.project_id != null && isKnownDependencyProvidedByDistribution(dependency.project_id, serv)) {
            state.logger.info(`Skipping Modrinth dependency ${dependency.project_id}; distribution already provides it.`)
            continue
        }
        await collectModrinthInstallPlan({
            project: dependency.project_id,
            versionId: dependency.version_id,
            displayName: dependency.project_id ?? dependency.version_id
        }, serv, minecraftVersion, loader, state)
    }

    const file = getPrimaryModrinthFile(version)
    if(file == null || file.url == null) {
        throw new Error(Lang.queryJS('landing.shaderLoader.noPrimaryFile', { name: version.name ?? version.id }))
    }
    if(file.hashes?.sha1 == null) {
        throw new Error(Lang.queryJS('landing.shaderLoader.noSha1', { name: file.filename ?? version.name ?? version.id }))
    }

    state.entries.push({
        projectId: version.project_id,
        versionId: version.id,
        versionName: version.name,
        fileName: file.filename,
        localName: getManagedFileName(version.project_id, version.id, file.filename),
        url: file.url,
        size: file.size ?? 0,
        sha1: file.hashes.sha1
    })
}

async function buildModrinthInstallPlan(choice, serv, minecraftVersion, loader, loggerLaunchSuite) {
    const shaderLoader = SHADER_LOADER_OPTIONS[choice]
    const state = {
        entries: [],
        seenVersions: new Set(),
        logger: loggerLaunchSuite
    }

    await collectModrinthInstallPlan({
        project: shaderLoader.project,
        displayName: shaderLoader.label
    }, serv, minecraftVersion, loader, state)

    return state.entries
}

async function downloadModrinthInstallPlan(entries, modsDir) {
    const assets = entries.map(entry => ({
        id: entry.localName,
        hash: entry.sha1,
        algo: HashAlgo.SHA1,
        size: entry.size,
        url: entry.url,
        path: nodePath.join(modsDir, entry.localName)
    }))

    const expectedTotalSize = getExpectedDownloadSize(assets)
    await downloadQueue(assets, received => {
        const percent = expectedTotalSize > 0 ? Math.trunc((received / expectedTotalSize) * 100) : 0
        setDownloadPercentage(percent)
    })
    setDownloadPercentage(100)

    for(const asset of assets) {
        if(!await validateLocalFile(asset.path, asset.algo, asset.hash)) {
            throw new Error(Lang.queryJS('landing.shaderLoader.validationFailed', { name: asset.id }))
        }
    }
}

async function ensureModrinthShaderLoader(choice, serv, minecraftVersion, loader, loggerLaunchSuite) {
    const modsDir = getServerModsDir(serv)
    neoForgeFS.ensureDirSync(modsDir)

    setLaunchDetails(Lang.queryJS('landing.shaderLoader.resolving'))
    const entries = await buildModrinthInstallPlan(choice, serv, minecraftVersion, loader, loggerLaunchSuite)
    if(entries.length === 0) {
        throw new Error(Lang.queryJS('landing.shaderLoader.emptyPlan'))
    }

    if(doesManagedManifestMatchPlan(modsDir, choice, minecraftVersion, loader, entries)
        && await isManagedShaderManifestCurrent(modsDir, choice, minecraftVersion, loader)) {
        setManagedShaderLoaderEnabled(modsDir, true)
        loggerLaunchSuite.info(`Managed shader loader ${choice} is already installed for ${minecraftVersion}/${loader}.`)
        return
    }

    cleanupManagedShaderLoader(modsDir)
    setLaunchDetails(Lang.queryJS('landing.shaderLoader.downloading'))
    setDownloadPercentage(0)
    await downloadModrinthInstallPlan(entries, modsDir)
    writeManagedShaderManifest(modsDir, choice, minecraftVersion, loader, entries)
}

function promptShaderLoaderChoice(shaderpack) {
    return new Promise(resolve => {
        const overlayActionContainer = document.getElementById('overlayActionContainer')
        setOverlayContent(
            Lang.queryJS('landing.shaderLoader.choiceTitle'),
            Lang.queryJS('landing.shaderLoader.choiceText', { shaderpack }),
            SHADER_LOADER_OPTIONS.iris.label,
            SHADER_LOADER_OPTIONS.optifine.label
        )
        setOverlayHandler(() => {
            overlayActionContainer.removeAttribute('shaderloaderchoice')
            toggleOverlay(false)
            resolve('iris')
        })
        setDismissHandler(() => {
            overlayActionContainer.removeAttribute('shaderloaderchoice')
            toggleOverlay(false)
            resolve('optifine')
        })
        overlayActionContainer.setAttribute('shaderloaderchoice', '')
        toggleOverlay(true, true)
    })
}

async function ensureShaderLoaderForLaunch(serv, loggerLaunchSuite) {
    const modsDir = getServerModsDir(serv)
    const shaderpack = LandingDropinModUtil.getEnabledShaderpack(getServerInstanceDir(serv))
    if(shaderpack == null || shaderpack === 'OFF') {
        setManagedShaderLoaderEnabled(modsDir, false)
        loggerLaunchSuite.info('No shaderpack enabled. Skipping shader loader installation.')
        return true
    }

    const minecraftVersion = serv.rawServer.minecraftVersion
    const loader = resolveServerModrinthLoader(serv)

    if(loader == null) {
        showLaunchFailure(
            Lang.queryJS('landing.shaderLoader.installFailedTitle'),
            Lang.queryJS('landing.shaderLoader.unsupportedLoader', { minecraftVersion })
        )
        return false
    }

    try {
        const manifest = readManagedShaderManifest(modsDir)
        if(manifest?.choice != null && SHADER_LOADER_OPTIONS[manifest.choice] != null) {
            toggleLaunchArea(true)
            setLaunchPercentage(0)
            await ensureModrinthShaderLoader(manifest.choice, serv, minecraftVersion, loader, loggerLaunchSuite)
            loggerLaunchSuite.info(`Prepared managed shader loader ${manifest.choice} for ${minecraftVersion}/${loader}.`)
            return true
        }

        const choice = await promptShaderLoaderChoice(shaderpack)
        toggleLaunchArea(true)
        setLaunchPercentage(0)
        await ensureModrinthShaderLoader(choice, serv, minecraftVersion, loader, loggerLaunchSuite)
        setLaunchDetails(Lang.queryJS('landing.shaderLoader.installed'))
        return true
    } catch(err) {
        loggerLaunchSuite.error('Failed to prepare shader loader.', err)
        remote.getCurrentWindow().setProgressBar(-1)
        showLaunchFailure(
            Lang.queryJS('landing.shaderLoader.installFailedTitle'),
            err.message || Lang.queryJS('landing.dlAsync.seeConsoleForDetails')
        )
        return false
    }
}

async function dlAsync(login = true) {

    // Login parameter is temporary for debug purposes. Allows testing the validation/downloads without
    // launching the game.

    const loggerLaunchSuite = LoggerUtil.getLogger('LaunchSuite')

    setLaunchDetails(Lang.queryJS('landing.dlAsync.loadingServerInfo'))

    let distro

    try {
        distro = await DistroAPI.refreshDistributionOrFallback()
        await onDistroRefresh(distro)
    } catch(err) {
        loggerLaunchSuite.error('Unable to refresh distribution index.', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.fatalError'), Lang.queryJS('landing.dlAsync.unableToLoadDistributionIndex'))
        return
    }

    const serv = distro.getServerById(ConfigManager.getSelectedServer())

    if(login) {
        if(ConfigManager.getSelectedAccount() == null){
            loggerLanding.error('You must be logged into an account.')
            return
        }
    }

    if(!await ensureShaderLoaderForLaunch(serv, loggerLaunchSuite)) {
        return
    }

    setLaunchDetails(Lang.queryJS('landing.dlAsync.pleaseWait'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    const fullRepairModule = new FullRepair(
        ConfigManager.getCommonDirectory(),
        ConfigManager.getInstanceDirectory(),
        ConfigManager.getLauncherDirectory(),
        ConfigManager.getSelectedServer(),
        DistroAPI.isDevMode()
    )

    fullRepairModule.spawnReceiver()

    fullRepairModule.childProcess.on('error', (err) => {
        loggerLaunchSuite.error('Error during launch', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), err.message || Lang.queryJS('landing.dlAsync.errorDuringLaunchText'))
    })
    fullRepairModule.childProcess.on('close', (code, _signal) => {
        if(code !== 0){
            loggerLaunchSuite.error(`Full Repair Module exited with code ${code}, assuming error.`)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
        }
    })

    loggerLaunchSuite.info('Validating files.')
    setLaunchDetails(Lang.queryJS('landing.dlAsync.validatingFileIntegrity'))
    let invalidFileCount = 0
    try {
        invalidFileCount = await fullRepairModule.verifyFiles(percent => {
            setLaunchPercentage(percent)
        })
        setLaunchPercentage(100)
    } catch (err) {
        loggerLaunchSuite.error('Error during file validation.')
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileVerificationTitle'), err.displayable || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
        return
    }


    if(invalidFileCount > 0) {
        loggerLaunchSuite.info('Downloading files.')
        setLaunchDetails(Lang.queryJS('landing.dlAsync.downloadingFiles'))
        setLaunchPercentage(0)
        try {
            await fullRepairModule.download(percent => {
                setDownloadPercentage(percent)
            })
            setDownloadPercentage(100)
        } catch(err) {
            loggerLaunchSuite.error('Error during file download.')
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileDownloadTitle'), err.displayable || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
            return
        }
    } else {
        loggerLaunchSuite.info('No invalid files, skipping download.')
    }

    // Remove download bar.
    remote.getCurrentWindow().setProgressBar(-1)

    fullRepairModule.destroyReceiver()

    setLaunchDetails(Lang.queryJS('landing.dlAsync.preparingToLaunch'))

    const mojangIndexProcessor = new MojangIndexProcessor(
        ConfigManager.getCommonDirectory(),
        serv.rawServer.minecraftVersion)
    const distributionIndexProcessor = new DistributionIndexProcessor(
        ConfigManager.getCommonDirectory(),
        distro,
        serv.rawServer.id
    )

    let modLoaderData
    try {
        modLoaderData = await distributionIndexProcessor.loadModLoaderVersionJson(serv)
        await ensureModLoaderLibraries(modLoaderData, loggerLaunchSuite)
        await ensureNeoForgeClientInstall(modLoaderData, serv, loggerLaunchSuite)
    } catch(err) {
        loggerLaunchSuite.error('Error during mod loader library preparation.', err)
        remote.getCurrentWindow().setProgressBar(-1)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileDownloadTitle'), err.displayable || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
        return
    }

    remote.getCurrentWindow().setProgressBar(-1)
    const versionData = await mojangIndexProcessor.getVersionJson()

    if(login) {
        setLaunchDetails(Lang.queryJS('landing.dlAsync.pleaseWait'))
        let authValid = false
        try {
            authValid = await LandingAuthManager.validateSelected()
        } catch(err) {
            loggerLaunchSuite.error('Error while validating selected account before launch.', err)
        }

        if(!authValid){
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
            return
        }

        const authUser = ConfigManager.getSelectedAccount()
        loggerLaunchSuite.info(`Sending selected account (${authUser.displayName}) to ProcessBuilder.`)
        let pb = new ProcessBuilder(serv, versionData, modLoaderData, authUser, remote.app.getVersion())
        setLaunchDetails(Lang.queryJS('landing.dlAsync.launchingGame'))
        const playerJoinedRegex = new RegExp(`\\[.+\\]: (?:\\[CHAT\\]|\\[System\\] \\[CHAT\\]) ${escapeRegex(authUser.displayName)} joined the game`)

        let rpcJoinFallback
        const clearRpcJoinFallback = () => {
            if(rpcJoinFallback){
                clearTimeout(rpcJoinFallback)
                rpcJoinFallback = null
            }
        }
        const updateRpcDetails = (details) => {
            if(hasRPC){
                DiscordWrapper.updateDetails(details)
            }
        }
        const updateRpcJoined = () => {
            clearRpcJoinFallback()
            updateRpcDetails(Lang.queryJS('landing.discord.joined'))
        }
        const updateRpcJoining = () => {
            updateRpcDetails(Lang.queryJS('landing.discord.joining'))
            clearRpcJoinFallback()
            rpcJoinFallback = setTimeout(updateRpcJoined, RPC_JOIN_FALLBACK_DELAY)
        }

        const onLoadComplete = () => {
            toggleLaunchArea(false)
            if(hasRPC){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.loading'))
                proc.stdout.on('data', gameStateChange)
            }
            proc.stdout.removeListener('data', tempListener)
            proc.stderr.removeListener('data', gameErrorListener)
        }
        const start = Date.now()

        // Attach a temporary listener to the client output.
        // Will wait for a certain bit of text meaning that
        // the client application has started, and we can hide
        // the progress bar stuff.
        const tempListener = function(data){
            if(GAME_LAUNCH_REGEX.test(data.trim())){
                const diff = Date.now()-start
                if(diff < MIN_LINGER) {
                    setTimeout(onLoadComplete, MIN_LINGER-diff)
                } else {
                    onLoadComplete()
                }
            }
        }

        // Listener for Discord RPC.
        const gameStateChange = function(data){
            data = data.trim()
            if(playerJoinedRegex.test(data) || SERVER_JOINED_REGEXES.some(regex => regex.test(data))){
                updateRpcJoined()
            } else if(SERVER_DISCONNECTED_REGEX.test(data)){
                clearRpcJoinFallback()
            } else if(GAME_JOINED_REGEX.test(data) || SERVER_CONNECTING_REGEX.test(data)){
                updateRpcJoining()
            }
        }

        const gameErrorListener = function(data){
            data = data.trim()
            if(data.indexOf('Could not find or load main class net.minecraft.launchwrapper.Launch') > -1){
                loggerLaunchSuite.error('Game launch failed, LaunchWrapper was not downloaded properly.')
                showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.launchWrapperNotDownloaded'))
            }
        }

        try {
            // Build Minecraft process.
            proc = pb.build()

            // Bind listeners to stdout.
            proc.stdout.on('data', tempListener)
            proc.stderr.on('data', gameErrorListener)

            setLaunchDetails(Lang.queryJS('landing.dlAsync.doneEnjoyServer'))

            // Init Discord Hook
            if(distro.rawDistribution.discord != null && serv.rawServer.discord != null){
                DiscordWrapper.initRPC(distro.rawDistribution.discord, serv.rawServer.discord)
                hasRPC = true
                proc.on('close', (code, signal) => {
                    loggerLaunchSuite.info('Shutting down Discord Rich Presence..')
                    clearRpcJoinFallback()
                    DiscordWrapper.shutdownRPC()
                    hasRPC = false
                    proc = null
                })
            }

        } catch(err) {

            loggerLaunchSuite.error('Error during launch', err)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.checkConsoleForDetails'))

        }
    }

}

/**
 * News Loading Functions
 */

// DOM Cache
const newsContent                   = document.getElementById('newsContent')
const newsArticleTitle              = document.getElementById('newsArticleTitle')
const newsArticleDate               = document.getElementById('newsArticleDate')
const newsArticleAuthor             = document.getElementById('newsArticleAuthor')
const newsArticleComments           = document.getElementById('newsArticleComments')
const newsNavigationStatus          = document.getElementById('newsNavigationStatus')
const newsArticleContentScrollable  = document.getElementById('newsArticleContentScrollable')
const nELoadSpan                    = document.getElementById('nELoadSpan')

// News slide caches.
let newsActive = false
let newsGlideCount = 0

/**
 * Show the news UI via a slide animation.
 *
 * @param {boolean} up True to slide up, otherwise false.
 */
function slide_(up){
    const lCUpper = document.querySelector('#landingContainer > #upper')
    const lCLLeft = document.querySelector('#landingContainer > #lower > #left')
    const lCLCenter = document.querySelector('#landingContainer > #lower > #center')
    const lCLRight = document.querySelector('#landingContainer > #lower > #right')
    const newsBtn = document.querySelector('#landingContainer > #lower > #center #content')
    const landingContainer = document.getElementById('landingContainer')
    const newsContainer = document.querySelector('#landingContainer > #newsContainer')

    newsGlideCount++

    if(up){
        lCUpper.style.top = '-200vh'
        lCLLeft.style.top = '-200vh'
        lCLCenter.style.top = '-200vh'
        lCLRight.style.top = '-200vh'
        newsBtn.style.top = '130vh'
        newsContainer.style.top = '0px'
        //date.toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric'})
        //landingContainer.style.background = 'rgba(29, 29, 29, 0.55)'
        landingContainer.style.background = 'rgba(0, 0, 0, 0.50)'
        setTimeout(() => {
            if(newsGlideCount === 1){
                lCLCenter.style.transition = 'none'
                newsBtn.style.transition = 'none'
            }
            newsGlideCount--
        }, 2000)
    } else {
        setTimeout(() => {
            newsGlideCount--
        }, 2000)
        landingContainer.style.background = null
        lCLCenter.style.transition = null
        newsBtn.style.transition = null
        newsContainer.style.top = '100%'
        lCUpper.style.top = '0px'
        lCLLeft.style.top = '0px'
        lCLCenter.style.top = '0px'
        lCLRight.style.top = '0px'
        newsBtn.style.top = '10px'
    }
}

// Bind news button.
document.getElementById('newsButton').onclick = () => {
    // Toggle tabbing.
    if(newsActive){
        $('#landingContainer *').removeAttr('tabindex')
        $('#newsContainer *').attr('tabindex', '-1')
    } else {
        $('#landingContainer *').attr('tabindex', '-1')
        $('#newsContainer, #newsContainer *, #lower, #lower #center *').removeAttr('tabindex')
        if(newsAlertShown){
            $('#newsButtonAlert').fadeOut(2000)
            newsAlertShown = false
            ConfigManager.setNewsCacheDismissed(true)
            ConfigManager.save()
        }
    }
    slide_(!newsActive)
    newsActive = !newsActive
}

// Array to store article meta.
let newsArr = null

// News load animation listener.
let newsLoadingListener = null

/**
 * Set the news loading animation.
 *
 * @param {boolean} val True to set loading animation, otherwise false.
 */
function setNewsLoading(val){
    if(val){
        const nLStr = Lang.queryJS('landing.news.checking')
        let dotStr = '..'
        nELoadSpan.innerHTML = nLStr + dotStr
        newsLoadingListener = setInterval(() => {
            if(dotStr.length >= 3){
                dotStr = ''
            } else {
                dotStr += '.'
            }
            nELoadSpan.innerHTML = nLStr + dotStr
        }, 750)
    } else {
        if(newsLoadingListener != null){
            clearInterval(newsLoadingListener)
            newsLoadingListener = null
        }
    }
}

// Bind retry button.
newsErrorRetry.onclick = () => {
    $('#newsErrorFailed').fadeOut(250, () => {
        initNews()
        $('#newsErrorLoading').fadeIn(250)
    })
}

newsArticleContentScrollable.onscroll = (e) => {
    if(e.target.scrollTop > Number.parseFloat($('.newsArticleSpacerTop').css('height'))){
        newsContent.setAttribute('scrolled', '')
    } else {
        newsContent.removeAttribute('scrolled')
    }
}

/**
 * Reload the news without restarting.
 *
 * @returns {Promise.<void>} A promise which resolves when the news
 * content has finished loading and transitioning.
 */
function reloadNews(){
    return new Promise((resolve, reject) => {
        $('#newsContent').fadeOut(250, () => {
            $('#newsErrorLoading').fadeIn(250)
            initNews().then(() => {
                resolve()
            })
        })
    })
}

let newsAlertShown = false

/**
 * Show the news alert indicating there is new news.
 */
function showNewsAlert(){
    newsAlertShown = true
    $(newsButtonAlert).fadeIn(250)
}

async function digestMessage(str) {
    const msgUint8 = new TextEncoder().encode(str)
    const hashBuffer = await crypto.subtle.digest('SHA-1', msgUint8)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    return hashHex
}

/**
 * Initialize News UI. This will load the news and prepare
 * the UI accordingly.
 *
 * @returns {Promise.<void>} A promise which resolves when the news
 * content has finished loading and transitioning.
 */
async function initNews(){

    setNewsLoading(true)

    const news = await loadNews()

    newsArr = news?.articles || null

    if(newsArr == null){
        // News Loading Failed
        setNewsLoading(false)

        await $('#newsErrorLoading').fadeOut(250).promise()
        await $('#newsErrorFailed').fadeIn(250).promise()

    } else if(newsArr.length === 0) {
        // No News Articles
        setNewsLoading(false)

        ConfigManager.setNewsCache({
            date: null,
            content: null,
            dismissed: false
        })
        ConfigManager.save()

        await $('#newsErrorLoading').fadeOut(250).promise()
        await $('#newsErrorNone').fadeIn(250).promise()
    } else {
        // Success
        setNewsLoading(false)

        const lN = newsArr[0]
        const cached = ConfigManager.getNewsCache()
        let newHash = await digestMessage(lN.content)
        let newDate = new Date(lN.date)
        let isNew = false

        if(cached.date != null && cached.content != null){

            if(new Date(cached.date) >= newDate){

                // Compare Content
                if(cached.content !== newHash){
                    isNew = true
                    showNewsAlert()
                } else {
                    if(!cached.dismissed){
                        isNew = true
                        showNewsAlert()
                    }
                }

            } else {
                isNew = true
                showNewsAlert()
            }

        } else {
            isNew = true
            showNewsAlert()
        }

        if(isNew){
            ConfigManager.setNewsCache({
                date: newDate.getTime(),
                content: newHash,
                dismissed: false
            })
            ConfigManager.save()
        }

        const switchHandler = (forward) => {
            let cArt = parseInt(newsContent.getAttribute('article'))
            let nxtArt = forward ? (cArt >= newsArr.length-1 ? 0 : cArt + 1) : (cArt <= 0 ? newsArr.length-1 : cArt - 1)

            displayArticle(newsArr[nxtArt], nxtArt+1)
        }

        document.getElementById('newsNavigateRight').onclick = () => { switchHandler(true) }
        document.getElementById('newsNavigateLeft').onclick = () => { switchHandler(false) }
        await $('#newsErrorContainer').fadeOut(250).promise()
        displayArticle(newsArr[0], 1)
        await $('#newsContent').fadeIn(250).promise()
    }


}

/**
 * Add keyboard controls to the news UI. Left and right arrows toggle
 * between articles. If you are on the landing page, the up arrow will
 * open the news UI.
 */
document.addEventListener('keydown', (e) => {
    if(newsActive){
        if(e.key === 'ArrowRight' || e.key === 'ArrowLeft'){
            document.getElementById(e.key === 'ArrowRight' ? 'newsNavigateRight' : 'newsNavigateLeft').click()
        }
        // Interferes with scrolling an article using the down arrow.
        // Not sure of a straight forward solution at this point.
        // if(e.key === 'ArrowDown'){
        //     document.getElementById('newsButton').click()
        // }
    } else {
        if(getCurrentView() === VIEWS.landing){
            if(e.key === 'ArrowUp'){
                document.getElementById('newsButton').click()
            }
        }
    }
})

/**
 * Display a news article on the UI.
 *
 * @param {Object} articleObject The article meta object.
 * @param {number} index The article index.
 */
function displayArticle(articleObject, index){
    newsArticleTitle.innerHTML = articleObject.title
    newsArticleTitle.href = articleObject.link
    newsArticleAuthor.innerHTML = 'by ' + articleObject.author
    newsArticleDate.innerHTML = articleObject.date
    newsArticleComments.innerHTML = articleObject.comments
    newsArticleComments.href = articleObject.commentsLink
    newsArticleContentScrollable.innerHTML = '<div id="newsArticleContentWrapper"><div class="newsArticleSpacerTop"></div>' + articleObject.content + '<div class="newsArticleSpacerBot"></div></div>'
    Array.from(newsArticleContentScrollable.getElementsByClassName('bbCodeSpoilerButton')).forEach(v => {
        v.onclick = () => {
            const text = v.parentElement.getElementsByClassName('bbCodeSpoilerText')[0]
            text.style.display = text.style.display === 'block' ? 'none' : 'block'
        }
    })
    newsNavigationStatus.innerHTML = Lang.query('ejs.landing.newsNavigationStatus', {currentPage: index, totalPages: newsArr.length})
    newsContent.setAttribute('article', index-1)
}

/**
 * Load news information from the RSS feed specified in the
 * distribution index.
 */
async function loadNews(){

    const distroData = await DistroAPI.getDistribution()
    if(!distroData.rawDistribution.rss) {
        loggerLanding.debug('No RSS feed provided.')
        return null
    }

    const promise = new Promise((resolve, reject) => {

        const newsFeed = distroData.rawDistribution.rss
        const newsHost = new URL(newsFeed).origin + '/'
        $.ajax({
            url: newsFeed,
            success: (data) => {
                const items = $(data).find('item')
                const articles = []

                for(let i=0; i<items.length; i++){
                // JQuery Element
                    const el = $(items[i])

                    // Resolve date.
                    const date = new Date(el.find('pubDate').text()).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric'})

                    // Resolve comments.
                    let comments = el.find('slash\\:comments').text() || '0'
                    comments = comments + ' Comment' + (comments === '1' ? '' : 's')

                    // Fix relative links in content.
                    let content = el.find('content\\:encoded').text()
                    let regex = /src="(?!http:\/\/|https:\/\/)(.+?)"/g
                    let matches
                    while((matches = regex.exec(content))){
                        content = content.replace(`"${matches[1]}"`, `"${newsHost + matches[1]}"`)
                    }

                    let link   = el.find('link').text()
                    let title  = el.find('title').text()
                    let author = el.find('dc\\:creator').text()

                    // Generate article.
                    articles.push(
                        {
                            link,
                            title,
                            date,
                            author,
                            content,
                            comments,
                            commentsLink: link + '#comments'
                        }
                    )
                }
                resolve({
                    articles
                })
            },
            timeout: 2500
        }).catch(err => {
            resolve({
                articles: null
            })
        })
    })

    return await promise
}
