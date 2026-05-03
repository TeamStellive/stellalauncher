const fs = require('fs-extra')
const path = require('path')
const { LoggerUtil } = require('helios-core')

const ConfigManager = require('./configmanager')

const logger = LoggerUtil.getLogger('ServerMigration')

const LEGACY_SERVER_ID_MIGRATIONS = {
    survival: '메인',
    admin: '관리자'
}

const USER_INSTANCE_PATHS = [
    'options.txt',
    'optionsof.txt',
    'optionsshaders.txt',
    'servers.dat',
    'config',
    'resourcepacks',
    'shaderpacks',
    'screenshots',
    'saves',
    'journeymap',
    'xaero'
]

async function migrateLegacyServerInstance(oldId, newId){
    const instanceDir = ConfigManager.getInstanceDirectory()
    const oldDir = path.join(instanceDir, oldId)
    const newDir = path.join(instanceDir, newId)

    if(!await fs.pathExists(oldDir)){
        return false
    }

    await fs.ensureDir(newDir)

    for(const relativePath of USER_INSTANCE_PATHS){
        const source = path.join(oldDir, relativePath)

        if(await fs.pathExists(source)){
            await fs.copy(source, path.join(newDir, relativePath), {
                overwrite: true,
                errorOnExist: false
            })
        }
    }

    return true
}

exports.migrateLegacyServerData = async function(data){
    const selectedServer = ConfigManager.getSelectedServer()

    if(selectedServer == null || data.getServerById(selectedServer) != null){
        return false
    }

    const migratedServerId = LEGACY_SERVER_ID_MIGRATIONS[selectedServer]

    if(migratedServerId == null || data.getServerById(migratedServerId) == null){
        ConfigManager.setSelectedServer(data.getMainServer().rawServer.id)
        ConfigManager.save()
        return false
    }

    const configMigrated = ConfigManager.migrateServerConfig(selectedServer, migratedServerId)
    const instanceMigrated = await migrateLegacyServerInstance(selectedServer, migratedServerId)

    ConfigManager.setSelectedServer(migratedServerId)
    ConfigManager.save()

    logger.info(`Migrated legacy server id ${selectedServer} to ${migratedServerId}.`)

    return configMigrated || instanceMigrated
}
