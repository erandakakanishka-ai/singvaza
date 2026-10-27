`stereo-synthetic.mp4` is a three-second, generated colour frame and synthetic
440 Hz centre / 710 Hz stereo-side test tone. It contains no third-party audio.

Reproduce with ffmpeg (H.264 and AAC encoders required):

```sh
ffmpeg -f lavfi -i 'color=c=0x245980:s=160x90:r=12:d=3' \
  -f lavfi -i 'aevalsrc=0.20*sin(2*PI*440*t)+0.12*sin(2*PI*710*t)|0.20*sin(2*PI*440*t)-0.12*sin(2*PI*710*t):s=48000:d=3' \
  -c:v libx264 -pix_fmt yuv420p -preset ultrafast -c:a aac -b:a 128k \
  -ac 2 -movflags +faststart -shortest stereo-synthetic.mp4
```
