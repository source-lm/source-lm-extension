export interface Settings {
  max_words_per_file: number;
  content_fields: 'auto' | string[];
  metadata: boolean;
  filename_pattern: string;     // placeholders {index} {title_slug} {cursor} {source}
  incremental: boolean;         // don't upload what's already in the notebook (checked by source names)
  source_name: string;          // manual override, empty = auto from JSON
}

export interface OutFile {
  filename: string;
  markdown: string;
  chars: number;
  words: number;
  records: number;
  cursor: string;                // raw cursor of the last record, for {cursor} in the filename
}

export interface PreviewResult {
  files: OutFile[];
  totalChars: number;
  warnings: string[];
}

export interface DetectedFields {
  titleField: string | null;
  contentFields: string[];
  dateField: string | null;
  tagsField: string | null;
  metadataFields: string[];
}
