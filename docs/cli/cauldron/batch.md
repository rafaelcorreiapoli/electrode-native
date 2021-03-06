## `ern cauldron batch`

#### Description

* Combine multiple Cauldron operations in a single command  

#### Syntax

`ern cauldron batch`  

**Options**  

`--addDependencies <dependencies..>`

* Add one or more native dependency versions to a target native application version Container  

`--updateDependencies <dependencies..>`  

* Update the version of one or more native dependencies in a native mobile application version Container

`--delDependencies <dependencies..>`

* Remove one or more native dependencies from a target native application version Container


`--addMiniapps <miniapps..>`

* Add one or more MiniApp versions to a target native application version Container


`--updateMiniapps <miniapps..>`

* Update the version of one or more MiniApps in a target native application version Container


`--delMiniapps <miniapps..>`

* Remove one or more MiniApps from a target native application version Container  

#### Remarks

* The `ern cauldron batch [--option <value..>]` command performs operations in the following order:  

1) [delDependencies]  
2) [delMiniapps]  
3) [updateDependencies]  
4) [updateMiniapps]  
5) [addDependencies]  
6) [addMiniapps]

[delDependencies]: del/dependencies.md
[delMiniapps]: del/miniapps.md
[updateDependencies]: update/dependencies.md
[updateMiniapps]: update/miniapps.md
[addDependencies]: add/dependencies.md
[addMiniapps]: add/miniapps.md
