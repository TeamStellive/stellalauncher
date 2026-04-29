/**
 * Path Sanitizer - 모든 경로 관련 작업에서 사용하는 중앙 통제 모듈
 * Windows 파일 시스템의 제약(콜론 문자 불허)을 처리합니다.
 */

const path = require('path')
const os = require('os')

class PathSanitizer {
    /**
     * Windows 경로에서 콜론을 언더바로 변환합니다.
     * 드라이브 문자(C:, D: 등)는 보존합니다.
     * 
     * @param {string} filePath - 변환할 경로
     * @returns {string} 안전화된 경로
     */
    static sanitizeForFS(filePath) {
        if (process.platform !== 'win32' || !filePath) {
            return filePath
        }

        const parsed = path.parse(filePath)
        // root가 'C:\' 같은 형식이므로, root 다음의 콜론만 변환
        const root = parsed.root || ''
        const afterRoot = filePath.slice(root.length)
        
        return root + afterRoot.replace(/:/g, '_')
    }

    /**
     * getPath()에서 반환되는 원본 경로를 안전한 파일 시스템 경로로 변환합니다.
     * 
     * @param {string} originalPath - getPath()에서 반환한 원본 경로
     * @returns {string} 파일 시스템에서 실제로 사용할 경로
     */
    static toSafePath(originalPath) {
        return this.sanitizeForFS(originalPath)
    }

    /**
     * 원본 경로 배열을 안전한 경로 배열로 변환합니다.
     * 
     * @param {string[]} paths - 원본 경로 배열
     * @returns {string[]} 안전화된 경로 배열
     */
    static toSafePaths(paths) {
        return paths.map(p => this.toSafePath(p))
    }

    /**
     * classpath 생성 시 사용하는 함수입니다.
     * Fabric의 경우 getPath()를 직접 classpath에 사용하므로 변환이 필요합니다.
     * 
     * @param {string} classpathEntry - classpath 항목
     * @returns {string} 안전화된 classpath 항목
     */
    static sanitizeClasspathEntry(classpathEntry) {
        return this.sanitizeForFS(classpathEntry)
    }

    /**
     * 경로 배열(library_directory 등)을 안전화합니다.
     * 
     * @param {string} pathString - 세미콜론이나 콜론으로 구분된 경로 문자열
     * @param {string} separator - 경로 구분자 (';' for Windows, ':' for Unix)
     * @returns {string} 안전화된 경로 문자열
     */
    static sanitizePathString(pathString, separator = ';') {
        if (process.platform !== 'win32') {
            return pathString
        }
        
        return pathString
            .split(separator)
            .map(p => this.toSafePath(p.trim()))
            .join(separator)
    }

    /**
     * 원본 경로와 안전한 경로의 매핑을 로깅합니다.
     * 디버깅용입니다.
     * 
     * @param {string} label - 라벨
     * @param {string} original - 원본 경로
     */
    static debugLog(label, original) {
        const safe = this.toSafePath(original)
        if (original !== safe) {
            console.log(`[PathSanitizer] ${label}`)
            console.log(`  Original: ${original}`)
            console.log(`  Safe:     ${safe}`)
        }
    }
}

module.exports = PathSanitizer
