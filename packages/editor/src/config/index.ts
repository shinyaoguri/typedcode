/**
 * Config Module
 *
 * Provides configuration for the editor application.
 */

export { configureMonacoWorkers } from './MonacoConfig.js';
export {
  type LanguageId,
  type LanguageDefinition,
  SUPPORTED_LANGUAGES,
  getLanguageDefinition,
  getExecutableLanguages,
  getAllLanguageIds,
  getLanguageIdByExtension,
  FILE_EXTENSIONS,
} from './SupportedLanguages.js';
