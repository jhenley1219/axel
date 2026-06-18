export type STTProvider = {
  transcribe(audio: Buffer, mimeType: string): Promise<string>
}
