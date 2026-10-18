# Дельта для домена workflow

## ADDED Requirements

### Requirement: Приёмка без .git
В release-каталоге без Git приёмка ДОЛЖНА брать SHA из RELEASE_SHA/BUILD_SHA и
проверять, что это 40-hex; иначе прогон запрещён.

#### Scenario: Release
- GIVEN .git отсутствует
- WHEN запускается acceptance --run
- THEN SHA берётся из RELEASE_SHA.
