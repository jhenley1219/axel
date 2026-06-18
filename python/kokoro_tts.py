"""Synthesize speech with Kokoro-82M (onnx) and write a WAV file.

Invoked by the server's /tts/synthesize route:
  python3 kokoro_tts.py --model-dir models/kokoro --voice af_heart --text "..." --output out.wav
"""
import argparse
from pathlib import Path

import soundfile as sf
from kokoro_onnx import Kokoro


def main() -> None:
	parser = argparse.ArgumentParser()
	parser.add_argument('--model-dir', required=True)
	parser.add_argument('--voice', default='af_heart')
	parser.add_argument('--speed', type=float, default=1.0)
	parser.add_argument('--text', required=True)
	parser.add_argument('--output', required=True)
	args = parser.parse_args()

	model_dir = Path(args.model_dir)
	kokoro = Kokoro(str(model_dir / 'kokoro-v1.0.onnx'), str(model_dir / 'voices-v1.0.bin'))
	samples, sample_rate = kokoro.create(args.text, voice=args.voice, speed=args.speed, lang='en-us')
	sf.write(args.output, samples, sample_rate)


if __name__ == '__main__':
	main()
