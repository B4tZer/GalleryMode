# GalleryMode

<img width="922" height="456" alt="image" src="https://github.com/user-attachments/assets/521d6a6b-80c3-40d3-92cd-e9dc060c9bfa" />

Rightclick a channel and select "Open GalleryMode"
Scroll through different media in a channel, with ability to favorite gifs.
You need to have the specific chanel open for the jump feature to work!

## Install
Official guide
https://docs.vencord.dev/installing/custom-plugins/

Quick guide:
Direct your terminal to the userplugins folder src/userplugins
```shell
git clone https://github.com/Sodroz/GalleryMode
````
Then rebuild 
````
pnpm build
````
````
pnpm inject
````
All Done!

## To Do
- Save position in viewer after jump - Done but needs minor tweaking
  
- A folder system for all media types accessable and viewable anywhere - might make a separate plugin for this or it will be V2 - tba 
  
## Known issues
- screen turning black/ui breaking - This is a limitation of chromium itself with how many videos it can decode at once, work around it by Keeping column counts reasonable (4-5) when browsing heavily animated or video-dense channels. or rip it and break it the choice is yours (ctrl + r) will fix it

- Media jumping around in masonry(adaptive) view mode - work around is to just scroll like a normal person, this is a gallery not tiktok or use grid(square)view

- Some formats not showing up in the gallery - partaly fixed but I'm sure there are still some edgecases and formats missing 

- Jump to message going to the wrong message in some cases - wip

## Please report bugs you find either in the Discord server post or Report the issue on github ❤️
  
