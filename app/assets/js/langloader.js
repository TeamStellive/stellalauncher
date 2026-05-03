const fs = require('fs-extra')
const got = require('got')
const path = require('path')
const toml = require('toml')
const merge = require('lodash.merge')
const { LoggerUtil } = require('helios-core')

let lang
const logger = LoggerUtil.getLogger('LangLoader')

exports.REMOTE_LANG_BASE_URL = 'https://r2.sunharu.dev'

function loadLanguageString(id, raw, source){
    lang = merge(lang || {}, toml.parse(raw) || {})
    logger.info(`Loaded language ${id} from ${source}.`)
}

exports.loadLanguage = function(id){
    loadLanguageString(id, fs.readFileSync(path.join(__dirname, '..', 'lang', `${id}.toml`), 'utf-8'), 'local file')
}

exports.loadRemoteLanguage = async function(id){
    const url = `${exports.REMOTE_LANG_BASE_URL}/${id}.toml`
    const res = await got.get(url, {
        responseType: 'text',
        timeout: {
            request: 10000
        }
    })
    loadLanguageString(id, res.body, url)
}

exports.query = function(id, placeHolders){
    let query = id.split('.')
    let res = lang
    for(let q of query){
        res = res[q]
    }
    let text = res === lang ? '' : res
    if (placeHolders) {
        Object.entries(placeHolders).forEach(([key, value]) => {
            text = text.replace(`{${key}}`, value)
        })
    }
    return text
}

exports.queryJS = function(id, placeHolders){
    return exports.query(`js.${id}`, placeHolders)
}

exports.queryEJS = function(id, placeHolders){
    return exports.query(`ejs.${id}`, placeHolders)
}

exports.setupLanguage = function(){
    lang = {}

    // Load Language Files
    exports.loadLanguage('ko_KR')
    // exports.loadLanguage('en_US')
    // Uncomment this when translations are ready
    //exports.loadLanguage('xx_XX')

    // Load Custom Language File for Launcher Customizer
    exports.loadLanguage('_custom')
}

exports.setupLanguageRemote = async function(){
    lang = {}

    // Load local language first
    exports.loadLanguage('ko_KR')

    try {
        await exports.loadRemoteLanguage('ko_KR')
    } catch(err) {
        logger.warn('Unable to load remote language ko_KR, using local file.', err)
    }

    // Load Custom Language File for Launcher Customizer
    exports.loadLanguage('_custom')
}
