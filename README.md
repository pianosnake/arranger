# Arranger

Live at https://pianosnake.github.io/arranger/

<p>
<img src="images/ipad.jpeg" alt="The arranger on an iPad: the style list, the chord being played, the style's tempo and sections, and STOP" width="74%">
<img src="images/phone.png" alt="The arranger on a phone: the same controls in one column" width="25%">
</p>

A Web MIDI page that plays Yamaha `.sty` and Roland `.stl` / `.sth` accompaniment styles. Connect a MIDI keyboard to this page, play chords on it, and the page plays the selected style through its built-in General MIDI synth. If that sounds really cheesy, then the page can send the parts on separate MIDI channels and you can connect your own soundfont player.

## Features

1. **Learn MIDI controls:** any button can be assigned to a CC, a note or a program change from any MIDI device, so foot switches, pads and knobs can run the arranger.
2. **Yamaha and Roland styles,** supported including odd meters. Upload your own. You can download some free Yamaha styles from [here](https://www.jjazzlab.org/en/resources/).
3. **Chord detection** below a split point, with chord latch, inversions and slash chords.
4. **Arranger sections:** intros, mains, fills, break and endings, with auto fill, sync start and "chord starts style".
5. **Built-in synth** with a General MIDI SoundFont, or your own `.sf2`.
6. **MIDI out:** each part on its own channel, with program change, mute and velocity per part.
7. **Tempo** with + / −, tap tempo, and volume, remembered for each style.
8. **Style library:** folders, search, favorites, a time signature filter and zip backup, starting with 11 styles.


It needs a browser with Web MIDI: desktop Chrome or Edge, Android Chrome or on the iPad / iPhone inside a [Web MIDI](https://apps.apple.com/us/app/web-midi-browser/id953846217) or [MIDI Web](https://midiweb.app/) browser app. MIDI Web also supports background playing for iOS.

On Android, Chrome's menu › **Add to Home screen** installs it as a full-screen app that also works with no internet.
