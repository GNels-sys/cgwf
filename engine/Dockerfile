# CGwF rules engine: headless Forge + JSON-over-WebSocket bridge.
# Stage 1 builds Forge (pinned tag) and this module; stage 2 is a JRE with the jar and the card data.
# Forge is cloned at build time (shallow, one tag) instead of being vendored: the repo is ~1 GB.

ARG FORGE_TAG=forge-2.0.15

FROM maven:3.9.9-eclipse-temurin-21 AS build
ARG FORGE_TAG
WORKDIR /src

# Forge: only the four GUI-less modules are built (core, game, ai, gui = model layer).
RUN git clone --depth 1 --branch ${FORGE_TAG} https://github.com/Card-Forge/forge.git forge
RUN cd forge && mvn -B -q -pl forge-core,forge-game,forge-ai,forge-gui -am -DskipTests -Dcheckstyle.skip -Dmaven.javadoc.skip=true install

# This module.
COPY pom.xml /src/engine/pom.xml
COPY src /src/engine/src
RUN cd engine && mvn -B -q -DskipTests package

# Only the resources Forge's model layer reads; skips adventure (140 MB), skins, music, fonts, translations.
RUN mkdir -p /out/forge-gui/res /out/forge-gui/res/languages \
 && cp -r forge/forge-gui/res/cardsfolder forge/forge-gui/res/tokenscripts forge/forge-gui/res/editions \
          forge/forge-gui/res/formats forge/forge-gui/res/blockdata forge/forge-gui/res/setlookup \
          forge/forge-gui/res/lists forge/forge-gui/res/ai forge/forge-gui/res/defaults \
          forge/forge-gui/res/draft forge/forge-gui/res/sealed forge/forge-gui/res/cube \
          forge/forge-gui/res/effects forge/forge-gui/res/deckgendecks forge/forge-gui/res/quest \
          forge/forge-gui/res/conquest forge/forge-gui/res/puzzle forge/forge-gui/res/tutorial \
          forge/forge-gui/res/howto.txt forge/forge-gui/res/licenses /out/forge-gui/res/ \
 && cp forge/forge-gui/res/languages/en-US.properties /out/forge-gui/res/languages/ \
 && cp forge/LICENSE /out/FORGE-LICENSE.txt

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /out/forge-gui /app/forge-gui
COPY --from=build /out/FORGE-LICENSE.txt /app/
COPY --from=build /src/engine/target/cgwf-engine.jar /app/cgwf-engine.jar
COPY spike/decks /app/decks
COPY LICENSE NOTICE /app/

ENV FORGE_ASSETS=/app/forge-gui \
    CGWF_DECKS=/app/decks \
    PORT=8081 \
    JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=70 -XX:+UseSerialGC -Xss2m"
EXPOSE 8081
ENTRYPOINT ["java", "-jar", "/app/cgwf-engine.jar"]
CMD ["serve"]
